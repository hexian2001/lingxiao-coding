/**
 * DistillCommand — /distill workflow extraction command.
 *
 * Scans session checkpoints/progress for repeated workflows,
 * identifies patterns, and packages them as reusable assets:
 * Skills (.lingxiao/skills/), Commands (.lingxiao/commands/), or Agents (.lingxiao/agents/).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { coreLogger } from '../core/Log.js';
import { contentToPlainText } from '../contracts/types/Message.js';
import { MemoryService } from './MemoryService.js';
import { createLLMClient } from '../llm/Client.js';
import { readRecentTrajectory, renderTrajectory, resolveSessionDbPath } from './TrajectoryReader.js';
import { AssetUsageStore, type AssetUsageStats } from './AssetUsageStore.js';
import type { DistillOptions, DistillResult, DistillAsset, AssetForm, TrajectoryTurn } from './types.js';

const DISTILL_SYSTEM_PROMPT = `You are an asset extraction assistant. You read the raw session trajectory (verbatim user/assistant turns and tool calls — the source of truth) alongside checkpoints and progress notes (a lossy index), and identify workflows that genuinely repeat, then decide which to package as reusable assets.

Your job, in order:
1. Read the material and find action sequences / workflows that recur across multiple sessions or turns. The raw trajectory is authoritative — judge repetition by what actually happened (repeated tool-call sequences, repeated user requests, repeated error/fix cycles), not by surface wording. Checkpoints/progress are a fast index into the trajectory, not the truth.
2. For each genuinely repeated workflow, decide whether it is worth extracting and which form fits best.
3. Ignore one-off actions and anything already covered by an existing asset.

Asset types:
1. Skill — a SKILL.md file with YAML frontmatter (name, description) and a markdown body describing the procedure.
2. Command — a command .md file with YAML frontmatter (name, description, agent) and a body with $ARGUMENTS placeholders.
3. Agent — an agent .md file with YAML frontmatter (name, description) plus optional model, tools, and skillNames; the markdown body is the agent's system prompt.

Rules:
- Only extract a workflow that you observe repeating at least twice in the material.
- Skip patterns already covered by existing assets.
- Choose the SMALLEST form that captures the pattern:
  - If it is a simple multi-step procedure → Skill
  - If it requires arguments and is invocable → Command
  - If it requires a distinct persona/toolset → Agent
  - If unclear or already covered → Skip
- Output ONLY valid JSON (no markdown fences, no prose outside JSON).

Output format:
{
  "assets": [
    {
      "form": "skill" | "command" | "agent" | "skip",
      "name": "kebab-case-name",
      "reason": "why this form was chosen, citing the repetition you observed",
      "content": "full file content including YAML frontmatter"
    }
  ],
  "skipped": ["name1 - reason"],
  "needsMoreEvidence": ["name1 - reason (e.g. seen only once)"]
}`;

/** Inventory entry handed to the LLM so it can judge content overlap, not just names. */
interface ExistingAssetSummary {
  /** form/name, e.g. skills/deploy-flow (filename noise stripped) */
  ref: string;
  /** frontmatter description, else first body line — lets the LLM dedupe by content */
  summary: string;
  /** real consultation count from AssetUsageStore (B signal); undefined when no ledger entry */
  uses?: number;
  lastUsedAt?: number;
  successCount?: number;
  failureCount?: number;
}

export class DistillCommand {
  private service: MemoryService;
  private dbPath: string | undefined;

  constructor(service: MemoryService, dbPath?: string) {
    this.service = service;
    this.dbPath = dbPath;
  }

  /**
   * Execute the distillation pipeline.
   *
   * Pattern identification is delegated entirely to the LLM working over raw
   * session material — there is NO local keyword/regex/frequency heuristic. The
   * model is the signal source: it reads the checkpoint and progress bodies,
   * judges which workflows genuinely repeat, and decides form + content in one
   * structured pass. This mirrors mimo's distill (LLM over raw trajectory) and
   * keeps the pipeline deterministic in its plumbing while leaving semantic
   * judgement to the model rather than a fabricated `count/5` score.
   */
  async execute(options: DistillOptions): Promise<DistillResult> {
    const { workspace } = options;
    const lookbackMs = (options.sessionLookbackDays ?? 14) * 24 * 60 * 60 * 1000;
    const lingxiaoRoot = join(workspace, '.lingxiao');
    const report = options.reporter;
    const usageStore = new AssetUsageStore(lingxiaoRoot);

    // Phase 1: Inventory existing assets, enriched with real usage counts so the LLM can
    // tell proven assets from dormant ones (B), and so the overwrite gate (C) lets proven
    // assets be refined instead of being protected-from-clobbering forever.
    report?.progress('scanning', 0.15, '扫描已有资产');
    const existingAssets = this.inventoryAssets(lingxiaoRoot, usageStore.getUsageStats());
    coreLogger.info(`[DistillCommand] Phase 1: Found ${existingAssets.length} existing assets`);

    // Phase 2: Gather raw session material. The trajectory tables are the source
    // of truth (verbatim turns + tool calls); checkpoints/progress are a lossy
    // index. distill judges repetition off real tool-call sequences, so the
    // trajectory is what actually surfaces repeated workflows — mimo reads the
    // raw `part` table for exactly this reason.
    report?.progress('reading', 0.35, '读取原始轨迹与会话材料');
    this.service.reconcile();
    const cutoff = Date.now() - lookbackMs;
    const trajectory = readRecentTrajectory(resolveSessionDbPath(this.dbPath), cutoff).reverse();
    const checkpoints = this.service.getRecentCheckpoints(cutoff);
    const progressEntries = this.service.search('workflow tool sequence pattern', {
      types: ['progress', 'checkpoint'],
      maxResults: 50,
    });
    coreLogger.info(`[DistillCommand] Phase 2: Found ${trajectory.length} trajectory turns, ${checkpoints.length} checkpoints, ${progressEntries.length} progress entries`);

    if (trajectory.length === 0 && checkpoints.length === 0 && progressEntries.length === 0) {
      coreLogger.info('[DistillCommand] No session data found. Nothing to distill.');
      return {
        created: [],
        skipped: [],
        needsMoreEvidence: [],
        considered: 0,
        conflicts: [],
        invalid: [],
        materialStats: { trajectoryTurns: 0, checkpoints: 0, progressEntries: 0 },
      };
    }

    const material = this.collectMaterial(checkpoints, progressEntries, trajectory);
    if (!material) {
      coreLogger.info('[DistillCommand] No usable session material. Nothing to distill.');
      return {
        created: [],
        skipped: [],
        needsMoreEvidence: [],
        considered: 0,
        conflicts: [],
        invalid: [],
        materialStats: {
          trajectoryTurns: trajectory.length,
          checkpoints: checkpoints.length,
          progressEntries: progressEntries.length,
        },
      };
    }

    // Phase 3: LLM identifies repeated workflows over the raw material, decides
    // form, and generates asset content. The model — not local string matching —
    // determines what repeats and whether it is worth extracting.
    report?.progress('generating', 0.6, '提炼可复用资产');
    const result = await this.generateAssets(existingAssets, material, lingxiaoRoot, Boolean(options.allowOverwrite), usageStore);
    result.materialStats = {
      trajectoryTurns: trajectory.length,
      checkpoints: checkpoints.length,
      progressEntries: progressEntries.length,
    };
    return result;
  }

  /**
   * Concatenate the raw trajectory (source of truth) plus checkpoint and
   * progress bodies (lossy index) into a single material block for the LLM to
   * reason over. No pattern extraction happens here — this is pure plumbing that
   * preserves the original text verbatim. Trajectory leads because it is what
   * actually surfaces repeated tool-call sequences and user requests.
   */
  collectMaterial(
    checkpoints: { body: string }[],
    progressEntries: { snippet: string }[],
    trajectory: TrajectoryTurn[] = [],
  ): string {
    const blocks: string[] = [];
    if (trajectory.length > 0) {
      blocks.push(`=== RAW TRAJECTORY — SOURCE OF TRUTH (${trajectory.length} turns, oldest first) ===\n${renderTrajectory(trajectory)}`);
    }
    checkpoints.forEach((cp, i) => {
      const body = cp.body?.trim();
      if (body) blocks.push(`--- checkpoint #${i + 1} ---\n${body}`);
    });
    progressEntries.forEach((pe, i) => {
      const snippet = pe.snippet?.trim();
      if (snippet) blocks.push(`--- progress #${i + 1} ---\n${snippet}`);
    });
    return blocks.join('\n\n');
  }

  /**
   * Phase 1: Scan .lingxiao/skills/, .lingxiao/commands/, .lingxiao/agents/ for existing assets.
   */
  inventoryAssets(lingxiaoRoot: string, usageStats?: Map<string, AssetUsageStats>): ExistingAssetSummary[] {
    const assets: ExistingAssetSummary[] = [];
    const dirs = ['skills', 'commands', 'agents'];

    for (const dir of dirs) {
      const dirPath = join(lingxiaoRoot, dir);
      if (!existsSync(dirPath)) continue;

      try {
        const entries = readdirSync(dirPath, { recursive: true }) as string[];
        for (const entry of entries) {
          const fullPath = join(dirPath, entry);
          try {
            if (!statSync(fullPath).isFile() || !entry.endsWith('.md')) continue;
            // ref = form/name (strip trailing /SKILL.md or .md) so the LLM sees clean
            // identities; summary = what the asset actually does, so overlap is judged
            // by content rather than by name alone (name-only dedup misses near-dupes).
            const name = entry.replace(/(?:^|\/)SKILL\.md$/, '').replace(/\.md$/, '');
            const ref = `${dir}/${name}`;
            const content = readFileSync(fullPath, 'utf-8');
            const stat = usageStats?.get(ref);
            assets.push({
              ref,
              summary: this.extractAssetSummary(content, name),
              uses: stat?.uses,
              lastUsedAt: stat?.lastUsedAt,
              successCount: stat?.successCount,
              failureCount: stat?.failureCount,
            });
          } catch {
            // skip inaccessible files
          }
        }
      } catch {
        // skip inaccessible directories
      }
    }

    return assets;
  }

  /**
   * Extract a one-line summary from an asset file: frontmatter `description` if
   * present, otherwise the first meaningful body line. Deterministic text
   * extraction only — no scoring, no classification.
   */
  private extractAssetSummary(content: string, fallback: string): string {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const desc = fmMatch[1].match(/^\s*description:\s*(.+)$/m);
      if (desc?.[1]) {
        return desc[1].trim().replace(/^["']|["']$/g, '').slice(0, 160);
      }
    }
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    const firstLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('---') && !l.startsWith('#'));
    return (firstLine || fallback).replace(/^#+\s*/, '').slice(0, 160);
  }

  /**
   * Call the LLM to identify repeated workflows over raw material, decide the
   * final form, and generate asset files. The model performs the semantic
   * judgement; this method only handles plumbing and disk writes.
   */
  private async generateAssets(
    existingAssets: ExistingAssetSummary[],
    material: string,
    lingxiaoRoot: string,
    allowOverwrite: boolean,
    usageStore: AssetUsageStore,
  ): Promise<DistillResult> {
    const userMessage = this.buildDistillPrompt(existingAssets, material);

    let llmOutput: string;
    try {
      const llm = createLLMClient();
      const response = await llm.generateContent({
        messages: [
          { role: 'system', content: DISTILL_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        model: '',
        maxTokens: 4000,
        sampling: { temperature: 0.2 },
      });
      llmOutput = contentToPlainText(response.content);
    } catch (err) {
      coreLogger.warn(`[DistillCommand] LLM call failed: ${err instanceof Error ? err.message : err}`);
      return { created: [], skipped: [], needsMoreEvidence: [], considered: 0, conflicts: [], invalid: [] };
    }

    // Parse LLM JSON response
    return this.parseAndWriteAssets(llmOutput, lingxiaoRoot, { allowOverwrite, usageStore });
  }

  /**
   * Build the user prompt: existing asset inventory + raw session material.
   * The LLM is responsible for finding what repeats — we hand it the source
   * text, not a pre-computed candidate list.
   */
  private buildDistillPrompt(existingAssets: ExistingAssetSummary[], material: string): string {
    const parts: string[] = [];

    parts.push('=== EXISTING ASSETS ===');
    if (existingAssets.length === 0) {
      parts.push('(none)');
    } else {
      parts.push(existingAssets.map((a) => {
        // Real usage signal (deterministic counts from AssetUsageStore), so the LLM can
        // tell proven assets from dormant ones. No threshold — the model decides what to do.
        const proven = a.uses != null && a.uses > 0;
        const last = a.lastUsedAt ? `, last ${new Date(a.lastUsedAt).toISOString().slice(0, 10)}` : '';
        const succ = a.successCount ? `, ${a.successCount} success` : '';
        const fail = a.failureCount ? `, ${a.failureCount} fail` : '';
        const usage = proven ? ` (used ${a.uses}x${last}${succ}${fail})` : ' (never recorded as used)';
        return `- ${a.ref}:${usage} ${a.summary}`;
      }).join('\n'));
    }
    parts.push('');

    parts.push('=== RAW SESSION MATERIAL ===');
    parts.push(material);
    parts.push('');

    parts.push('Identify workflows that genuinely repeat across the material above. For each, judge whether it is worth packaging and choose the smallest fitting form. Skip anything already covered by existing assets or seen only once. Output JSON only.');
    return parts.join('\n');
  }

  /**
   * Parse LLM JSON output and write asset files to disk.
   */
  parseAndWriteAssets(
    llmOutput: string,
    lingxiaoRoot: string,
    options: { allowOverwrite?: boolean; usageStore?: AssetUsageStore } = {},
  ): DistillResult {
    // Strip markdown code fences if present
    let jsonStr = llmOutput.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    let parsed: { assets?: unknown[]; skipped?: string[]; needsMoreEvidence?: string[] };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      coreLogger.warn('[DistillCommand] Failed to parse LLM JSON output');
      return {
        created: [],
        skipped: [],
        needsMoreEvidence: [],
        considered: 0,
        conflicts: [],
        invalid: ['llm-output - invalid JSON'],
      };
    }

    const created: DistillAsset[] = [];
    const skipped = parsed.skipped ?? [];
    const needsMoreEvidence = parsed.needsMoreEvidence ?? [];
    const conflicts: string[] = [];
    const invalid: string[] = [];

    const rawAssets = Array.isArray(parsed.assets) ? parsed.assets : [];
    for (const raw of rawAssets) {
      if (!raw || typeof raw !== 'object') continue;
      const { form, name, content } = raw as { form?: string; name?: string; content?: string };
      if (!form || !name || !content || form === 'skip') {
        if (name) skipped.push(name);
        continue;
      }

      const assetForm = form as AssetForm;
      if (!this.isValidAssetForm(assetForm)) {
        const reason = `${name} - invalid form: ${form}`;
        invalid.push(reason);
        skipped.push(reason);
        continue;
      }
      if (!this.isSafeAssetName(name)) {
        const reason = `${name} - invalid asset name`;
        invalid.push(reason);
        skipped.push(reason);
        continue;
      }
      if (!this.hasRequiredFrontmatter(content, assetForm)) {
        const reason = `${name} - invalid ${assetForm} frontmatter`;
        invalid.push(reason);
        skipped.push(reason);
        continue;
      }

      const filePath = this.resolveAssetPath(lingxiaoRoot, assetForm, name);
      if (!filePath) {
        const reason = `${name} - invalid form`;
        invalid.push(reason);
        skipped.push(reason);
        continue;
      }

      // C: an existing asset that has been observed in use may be overwritten (refined by the
      // LLM); a never-used asset stays protected from clobbering. Deterministic usage fact
      // (hasUsage = at least one recorded consultation), not a confidence threshold.
      const ref = `${assetForm === 'skill' ? 'skills' : assetForm === 'command' ? 'commands' : 'agents'}/${name}`;
      const hasRecordedUsage = options.usageStore?.hasUsage(ref) ?? false;
      if (existsSync(filePath) && !options.allowOverwrite && !hasRecordedUsage) {
        const reason = `${name} - target already exists: ${filePath}`;
        conflicts.push(reason);
        skipped.push(reason);
        continue;
      }

      // Write to disk
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, 'utf-8');

      created.push({ form: assetForm, name, path: filePath, content });
      coreLogger.info(`[DistillCommand] Created ${assetForm}: ${filePath}`);
    }

    return { created, skipped, needsMoreEvidence, considered: rawAssets.length, conflicts, invalid };
  }

  private isValidAssetForm(form: string): form is Exclude<AssetForm, 'skip'> {
    return form === 'skill' || form === 'command' || form === 'agent';
  }

  private isSafeAssetName(name: string): boolean {
    // Letter-start keeps distilled agent names inside
    // AgentDefinitionService.validateAgentDefinitionName (/^[A-Za-z][A-Za-z0-9_-]{1,63}$/).
    // A digit-leading name would pass here, write to disk, then THROW on load — and
    // listDefinitions has no per-file guard, so one bad name would crash the whole
    // RoleRegistry build (and thus session startup). Letter-start is a safe constraint
    // for all three forms (skills/commands are not name-validated by their loaders).
    return /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(name);
  }

  private hasRequiredFrontmatter(content: string, form: Exclude<AssetForm, 'skip'>): boolean {
    if (!content.startsWith('---\n')) return false;
    const end = content.indexOf('\n---', 4);
    if (end < 0) return false;
    const frontmatter = content.slice(4, end);
    if (form === 'skill') {
      return /\bname\s*:\s*\S+/.test(frontmatter) && /\bdescription\s*:\s*\S+/.test(frontmatter);
    }
    if (form === 'command') {
      return /\bname\s*:\s*\S+/.test(frontmatter)
        && /\bdescription\s*:\s*\S+/.test(frontmatter)
        && /\bagent\s*:\s*\S+/.test(frontmatter);
    }
    // Agent: the loader (AgentDefinitionService) requires a non-empty description and
    // uses the filename as the name fallback; model/tools/baseRole/skillNames are all
    // optional (tools defaults to WORKER_TOOLS). So name + description are the only
    // hard requirements. The old check required `mode` — a field the loader never reads
    // (its schema has no `mode` key; .passthrough silently drops it) — and omitted `name`,
    // so it both enforced a dead field and missed a real one.
    return /\bname\s*:\s*\S+/.test(frontmatter) && /\bdescription\s*:\s*\S+/.test(frontmatter);
  }

  /**
   * Resolve the filesystem path for an asset given its form and name.
   */
  private resolveAssetPath(lingxiaoRoot: string, form: AssetForm, name: string): string | null {
    switch (form) {
      case 'skill':
        return join(lingxiaoRoot, 'skills', name, 'SKILL.md');
      case 'command':
        return join(lingxiaoRoot, 'commands', `${name}.md`);
      case 'agent':
        return join(lingxiaoRoot, 'agents', `${name}.md`);
      default:
        return null;
    }
  }
}
