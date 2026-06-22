import fs from "node:fs/promises";
import process from "node:process";
import OpenAI from "openai";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";
const DEFAULT_MODEL = "glm-5.2";
const COMMENT_MARKER = "<!-- codex:glm-pr-review -->";
const MAX_FILES = 25;
const MAX_PATCH_CHARS = 50000;
const MAX_PATCH_PER_FILE = 6000;

async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  const zhipuApiKey = process.env.ZHIPU_API_KEY;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const manualPullNumber = process.env.GLM_REVIEW_PULL_NUMBER;

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required.");
  }

  if (!zhipuApiKey) {
    console.log("ZHIPU_API_KEY is not configured; skipping.");
    return;
  }

  if (!repository || !eventPath) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required.");
  }

  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  let pr = event.pull_request;
  if (!pr) {
    if (!manualPullNumber) {
      throw new Error("This workflow requires pull_request_target payload or GLM_REVIEW_PULL_NUMBER.");
    }

    const [owner, repo] = repository.split("/");
    pr = await fetchPullRequest({
      owner,
      repo,
      pullNumber: Number(manualPullNumber),
      token: githubToken,
    });
  }

  if (pr.draft) {
    console.log("Draft pull request detected; skipping.");
    return;
  }

  if (pr.head?.repo?.full_name !== pr.base?.repo?.full_name) {
    console.log("Fork pull request detected; skipping comment review for safety.");
    return;
  }

  const [owner, repo] = repository.split("/");
  const files = await fetchAllPullRequestFiles({
    owner,
    repo,
    pullNumber: pr.number,
    token: githubToken,
  });
  const diffBundle = buildDiffBundle(files);

  const commentBody = diffBundle.reviewablePatch
    ? await createReviewComment({
        owner,
        repo,
        pr,
        diffBundle,
        zhipuApiKey,
      })
    : renderComment({
        pr,
        reviewMarkdown: [
          "## 结论",
          "",
          "这次变更没有可供模型审查的文本 patch，可能是二进制文件、纯重命名，或 GitHub 未返回补丁内容。",
          "",
          "## 发现",
          "",
          "暂无。",
          "",
          "## 建议测试",
          "",
          "- 如果这是代码 PR，可以重新触发一次工作流后再看结果",
          "- 如果主要是二进制资源或大文件改动，继续依赖人工审查",
        ].join("\n"),
        diffBundle,
      });

  await upsertIssueComment({
    owner,
    repo,
    issueNumber: pr.number,
    token: githubToken,
    body: commentBody,
  });
}

async function createReviewComment({ owner, repo, pr, diffBundle, zhipuApiKey }) {
  const client = new OpenAI({
    apiKey: zhipuApiKey,
    baseURL: process.env.ZHIPU_BASE_URL || DEFAULT_BASE_URL,
  });

  const model = process.env.ZHIPU_MODEL || DEFAULT_MODEL;
  const messages = [
    {
      role: "system",
      content: [
        "你是一名资深代码审查工程师，负责审查 Pull Request。",
        "请只关注高价值问题：功能错误、潜在回归、安全风险、边界条件、缺失测试、明显的维护性陷阱。",
        "不要泛泛表扬，不要复述 diff。",
        "如果没有明确的可执行问题，请明确写“未发现需要阻塞的明显问题”，并补一句剩余风险或测试关注点。",
        "请用中文输出，使用 Markdown，结构固定为：",
        "## 结论",
        "## 发现",
        "## 建议测试",
        "在“发现”里优先列出具体问题，尽量给出文件路径和行号；如果没有问题，写“暂无”。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `仓库：${owner}/${repo}`,
        `PR：#${pr.number} ${pr.title}`,
        `Base：${pr.base.ref}`,
        `Head：${pr.head.ref}`,
        "",
        "以下是这次 PR 的关键信息：",
        pr.body ? `PR 描述：\n${pr.body}` : "PR 描述：无",
        "",
        "以下是裁剪后的 diff（可能已截断，只保留了最关键部分）：",
        diffBundle.reviewablePatch,
      ].join("\n"),
    },
  ];

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    messages,
  });

  const reviewMarkdown = completion.choices?.[0]?.message?.content?.trim();
  if (!reviewMarkdown) {
    throw new Error("GLM returned an empty review response.");
  }

  return renderComment({ pr, reviewMarkdown, diffBundle, model });
}

function renderComment({ pr, reviewMarkdown, diffBundle, model = DEFAULT_MODEL }) {
  const truncationNotice = [];
  if (diffBundle.totalFiles > diffBundle.includedFiles) {
    truncationNotice.push(`文件数已裁剪：${diffBundle.includedFiles}/${diffBundle.totalFiles}`);
  }
  if (diffBundle.truncatedFiles.length > 0) {
    truncationNotice.push(`单文件 patch 已裁剪：${diffBundle.truncatedFiles.join(", ")}`);
  }
  if (diffBundle.omittedFiles.length > 0) {
    truncationNotice.push(`未纳入 patch：${diffBundle.omittedFiles.join(", ")}`);
  }

  const metaLines = [
    COMMENT_MARKER,
    "## GLM 审查信息",
    `- PR: #${pr.number}`,
    `- 模型: ${model}`,
    `- 审查文件: ${diffBundle.includedFiles}/${diffBundle.totalFiles}`,
  ];

  if (truncationNotice.length > 0) {
    metaLines.push(`- 裁剪说明: ${truncationNotice.join("；")}`);
  }

  return `${metaLines.join("\n")}\n\n${reviewMarkdown}\n`;
}

function buildDiffBundle(files) {
  const truncatedFiles = [];
  const omittedFiles = [];
  const sections = [];
  let usedChars = 0;

  for (const file of files.slice(0, MAX_FILES)) {
    if (!file.patch) {
      omittedFiles.push(file.filename);
      continue;
    }

    let patch = file.patch;
    if (patch.length > MAX_PATCH_PER_FILE) {
      patch = `${patch.slice(0, MAX_PATCH_PER_FILE)}\n... [patch truncated]`;
      truncatedFiles.push(file.filename);
    }

    const section = [
      `--- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions}) ---`,
      patch,
    ].join("\n");

    if (usedChars + section.length > MAX_PATCH_CHARS) {
      omittedFiles.push(file.filename);
      continue;
    }

    sections.push(section);
    usedChars += section.length;
  }

  return {
    includedFiles: sections.length,
    omittedFiles,
    reviewablePatch: sections.join("\n\n"),
    totalFiles: files.length,
    truncatedFiles,
  };
}

async function fetchAllPullRequestFiles({ owner, repo, pullNumber, token }) {
  const files = [];
  let page = 1;

  while (true) {
    const response = await githubApi({
      token,
      path: `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
    });
    const batch = await response.json();
    files.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page += 1;
  }

  return files;
}

async function fetchPullRequest({ owner, repo, pullNumber, token }) {
  const response = await githubApi({
    token,
    path: `/repos/${owner}/${repo}/pulls/${pullNumber}`,
  });
  return response.json();
}

async function upsertIssueComment({ owner, repo, issueNumber, token, body }) {
  const comments = await listIssueComments({ owner, repo, issueNumber, token });
  const existing = comments.find(
    (comment) => typeof comment.body === "string" && comment.body.includes(COMMENT_MARKER),
  );

  if (existing) {
    await githubApi({
      token,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      body: { body },
    });
    return;
  }

  await githubApi({
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    body: { body },
  });
}

async function listIssueComments({ owner, repo, issueNumber, token }) {
  const response = await githubApi({
    token,
    path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
  });
  return response.json();
}

async function githubApi({ token, path, method = "GET", body }) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "lingxiao-glm-pr-review",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${details}`);
  }

  return response;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
