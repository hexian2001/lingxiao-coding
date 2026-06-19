/**
 * LaTeX → Unicode 近似转换器（纯函数，零依赖）。
 *
 * 终端无法绘制真正的图形公式（KaTeX/MathJax 只能在 Web 渲染），
 * 这里把常见 LaTeX 数学结构转换成 Unicode 数学符号的可读文本近似：
 *   E=mc^2          → E=mc²
 *   \sum_{i=1}^{n}  → ∑(i=1 → n)
 *   \frac{a}{b}     → a/b
 *   \sqrt{x^2+y^2}  → √(x²+y²)
 *   \mathbb{R}      → ℝ
 *
 * 设计原则（确定性，无启发式）：
 * - 递归下降扫描，正确处理 `{...}` 分组与嵌套（\sqrt{x^2} → √x²）。
 * - 已知命令查表替换；未知命令（\foobar）逐字保留，不删不改。
 * - Unicode 上/下标字符集有限，无法完全映射时回退为 `^(...)`/`_(...)` 形式，
 *   既不丢信息也不崩。
 */

// ── 上下标 Unicode 映射（覆盖有对应字符的 ASCII）──────────────────────
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ', 'i': 'ⁱ',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
  'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
  'v': '₥', 'x': 'ₓ',
};

/** 逐字符尝试映射为上标；任一字符无映射则整体回退为 `^(原文)`。 */
function toSuperscript(content: string): string {
  if (!content) return '';
  let mapped = '';
  for (const ch of content) {
    const m = SUPERSCRIPT[ch];
    if (m === undefined) return `^(${content})`;
    mapped += m;
  }
  return mapped;
}

/** 逐字符尝试映射为下标；任一字符无映射则整体回退为 `_(原文)`（与上标对称）。 */
function toSubscript(content: string): string {
  if (!content) return '';
  let mapped = '';
  for (const ch of content) {
    const m = SUBSCRIPT[ch];
    if (m === undefined) return `_(${content})`;
    mapped += m;
  }
  return mapped;
}

// ── 无参数符号命令（\name → 符号）──────────────────────────────────
const SYMBOLS: Record<string, string> = {
  // 希腊小写
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // 希腊大写
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν',
  Xi: 'Ξ', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ',
  Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  // 求积/求和/积分
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', oint: '∮', iint: '∬', iiint: '∭',
  // 二元运算
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '★', circ: '∘', bullet: '•',
  cap: '∩', cup: '∪', setminus: '∖', wedge: '∧', vee: '∨', oplus: '⊕', otimes: '⊗',
  // 关系
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', doteq: '≐',
  ll: '≪', gg: '≫', prec: '≺', succ: '≻', subset: '⊂', subseteq: '⊆',
  supset: '⊃', supseteq: '⊇', sqsubset: '⊏', sqsubseteq: '⊑',
  // 集合
  in: '∈', notin: '∉', ni: '∋', emptyset: '∅', varnothing: '∅', forall: '∀',
  exists: '∃', nexists: '∄',
  // 箭头
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕', hookrightarrow: '↪', leadsto: '⇝',
  // 杂项
  infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', imath: 'ı', jmath: 'ȷ',
  Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', angle: '∠', measuredangle: '∡', perp: '⊥',
  parallel: '∥', prime: '′', flat: '♭', natural: '♮', sharp: '♯',
  // 省略号
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  // 度等
  deg: '°',
  // 函数名(去反斜杠,保留名字)
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', coth: 'coth',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  lim: 'lim', limsup: 'lim sup', liminf: 'lim inf',
  min: 'min', max: 'max', sup: 'sup', inf: 'inf',
  det: 'det', dim: 'dim', gcd: 'gcd', arg: 'arg', ker: 'ker', Pr: 'Pr',
  // 字体修饰（无参数版本，罕见）
  boldsymbol: '', textnormal: '',
};

// ── 带参数命令（参数个数）──────────────────────────────────────────
const ARG_ARITY: Record<string, number> = {
  frac: 2, tfrac: 2, dfrac: 2, binom: 2, dbinom: 2, tbinom: 2,
  sqrt: 1, root: 0, // root 用 \sqrt[n]{x} 语法，n 走可选 [..]
  mathbb: 1, mathbf: 1, mathit: 1, mathrm: 1, mathsf: 1, mathtt: 1,
  mathcal: 1, mathscr: 1, operatorname: 1, text: 1, textrm: 1, textit: 1,
  textbf: 1, mbox: 1,
  hat: 1, bar: 1, overline: 1, underline: 1, vec: 1, dot: 1, ddot: 1,
  tilde: 1, widehat: 1, widetilde: 1, check: 1, breve: 1, acute: 1, grave: 1,
  overrightarrow: 1, overleftarrow: 1,
};

// ── 转义单字符（\X → 字面）─────────────────────────────────────────
const ESCAPES: Record<string, string> = {
  $: '$', '%': '%', '&': '&', _: '_', '#': '#', '{': '{', '}': '}',
  ',': '', ';': '', ':': '', '!': '', ' ': ' ', '|': '|', '/': '/',
  '\\': ' ', // LaTeX 换行 \\ → 空格
};

// ── 黑板粗体 \mathbb{X} ────────────────────────────────────────────
const BLACKBOARD: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', H: 'ℍ', P: 'ℙ',
  A: '𝔸', B: '𝔹', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', I: '𝕀',
  J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', O: '𝕆', S: '𝕊', T: '𝕋',
  U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐',
  '0': '𝟘', '1': '𝟙', '2': '𝟚', '3': '𝟛', '4': '𝟜',
  '5': '𝟝', '6': '𝟞', '7': '𝟟', '8': '𝟠', '9': '𝟡',
};

function toBlackboard(content: string): string {
  let out = '';
  for (const ch of content) {
    out += BLACKBOARD[ch] ?? ch;
  }
  return out;
}

/** \sqrt 的被开方体：含运算符或过长则加括号，避免 √x+y 读成 (√x)+y。 */
function sqrtBody(body: string): string {
  if (!body) return '';
  if (body.length <= 1) return body;
  if (/[ +\-/=,]/.test(body)) return `(${body})`;
  if (body.length > 4) return `(${body})`;
  return body;
}

/** 组合重音（U+0302 等 combining mark）加在 base 尾字符上。 */
function combineAccent(base: string, accent: string): string {
  if (!base) return '';
  if (base.length <= 1) return base + accent;
  return base.slice(0, -1) + base[base.length - 1]! + accent;
}

function applyArgCommand(name: string, args: string[], optN: string): string {
  switch (name) {
    case 'frac': case 'tfrac': case 'dfrac':
      return `${args[0] ?? ''}/${args[1] ?? ''}`;
    case 'binom': case 'dbinom': case 'tbinom':
      return `${args[0] ?? ''} C ${args[1] ?? ''}`;
    case 'sqrt':
      return optN ? `${optN}√${sqrtBody(args[0] ?? '')}` : `√${sqrtBody(args[0] ?? '')}`;
    case 'mathbb':
      return toBlackboard(args[0] ?? '');
    case 'mathrm': case 'text': case 'textrm': case 'operatorname':
    case 'mathsf': case 'mathtt': case 'mbox': case 'textnormal':
      return args[0] ?? '';
    case 'mathbf': case 'mathit': case 'mathcal': case 'mathscr':
    case 'textbf': case 'textit':
      return args[0] ?? '';
    case 'hat': case 'widehat':     return combineAccent(args[0] ?? '', '̂');
    case 'bar': case 'overline':    return combineAccent(args[0] ?? '', '̄');
    case 'tilde': case 'widetilde': return combineAccent(args[0] ?? '', '̃');
    case 'vec': case 'overrightarrow': return combineAccent(args[0] ?? '', '⃗');
    case 'dot':                     return combineAccent(args[0] ?? '', '̇');
    case 'ddot':                    return combineAccent(args[0] ?? '', '̈');
    case 'check':                   return combineAccent(args[0] ?? '', '̌');
    case 'breve':                   return combineAccent(args[0] ?? '', '̆');
    case 'acute':                   return combineAccent(args[0] ?? '', '́');
    case 'grave':                   return combineAccent(args[0] ?? '', '̀');
    case 'underline':               return args[0] ?? '';
    default:
      // 未识别的带参命令：保留原样（含参数），确定性不丢信息。
      return `\\${name}` + args.map((a) => `{${a}}`).join('');
  }
}

// ── 低层读取工具 ────────────────────────────────────────────────────

/** 解析单个原子（无参数命令/转义/单字符），返回其 Unicode 文本与结束位置。 */
function parseToken(input: string, start: number): { text: string; next: number } {
  const c = input[start];
  if (c === '\\') {
    const nx = input[start + 1];
    if (nx !== undefined && !/[a-zA-Z]/.test(nx)) {
      const esc = ESCAPES[nx];
      return { text: esc !== undefined ? esc : nx, next: start + 2 };
    }
    let j = start + 1;
    let name = '';
    while (j < input.length && /[a-zA-Z]/.test(input[j]!)) {
      name += input[j];
      j++;
    }
    const sym = SYMBOLS[name];
    if (sym !== undefined) return { text: sym, next: j };
    return { text: `\\${name}`, next: j };
  }
  return { text: c ?? '', next: start + 1 };
}

/** 从 open 位置（input[open]==='{'）读取到匹配的 '}'，返回组内容与结束位置。 */
function findBraceGroup(input: string, open: number): { content: string; next: number } | null {
  let depth = 1;
  let j = open + 1;
  const start = j;
  while (j < input.length && depth > 0) {
    const ch = input[j]!;
    if (ch === '\\') { j += 2; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    j++;
  }
  if (depth !== 0) return null;
  return { content: input.slice(start, j), next: j + 1 };
}

/** 读取一个命令参数或上下标目标：跳过空白后读 {...} 或单原子。 */
function readArg(input: string, from: number): { text: string; next: number } {
  let k = from;
  while (k < input.length && input[k] === ' ') k++;
  if (input[k] === '{') {
    const g = findBraceGroup(input, k);
    if (g) return { text: latexToUnicode(g.content), next: g.next };
    return { text: '', next: k };
  }
  if (k >= input.length) return { text: '', next: k };
  const tok = parseToken(input, k);
  return { text: tok.text, next: tok.next };
}

// ── 主转换 ──────────────────────────────────────────────────────────

/**
 * 把 LaTeX 数学片段转换为 Unicode 近似文本。
 * 递归下降，正确处理 `{...}` 分组与上下标作用域。
 */
export function latexToUnicode(latex: string): string {
  if (!latex) return '';
  let out = '';
  let i = 0;
  const n = latex.length;

  while (i < n) {
    const c = latex[i]!;

    if (c === '\\') {
      const nx = latex[i + 1];
      if (nx !== undefined && !/[a-zA-Z]/.test(nx)) {
        const esc = ESCAPES[nx];
        out += esc !== undefined ? esc : nx;
        i += 2;
        continue;
      }
      let j = i + 1;
      let name = '';
      while (j < n && /[a-zA-Z]/.test(latex[j]!)) {
        name += latex[j];
        j++;
      }
      const arity = ARG_ARITY[name];
      if (arity !== undefined) {
        let k = j;
        let optN = '';
        if (name === 'sqrt') {
          let p = k;
          while (p < n && latex[p] === ' ') p++;
          if (latex[p] === '[') {
            const close = latex.indexOf(']', p);
            if (close >= 0) {
              optN = latexToUnicode(latex.slice(p + 1, close));
              k = close + 1;
            }
          }
        }
        const args: string[] = [];
        for (let a = 0; a < arity; a++) {
          const r = readArg(latex, k);
          args.push(r.text);
          k = r.next;
        }
        out += applyArgCommand(name, args, optN);
        i = k;
        continue;
      }
      const sym = SYMBOLS[name];
      if (sym !== undefined) {
        out += sym;
        i = j;
        continue;
      }
      // 未知命令：逐字保留（含反斜杠），确定性不删。
      out += `\\${name}`;
      i = j;
      continue;
    }

    if (c === '^' || c === '_') {
      const r = readArg(latex, i + 1);
      out += c === '^' ? toSuperscript(r.text) : toSubscript(r.text);
      i = r.next;
      continue;
    }

    if (c === '{') {
      const g = findBraceGroup(latex, i);
      if (g) {
        out += latexToUnicode(g.content);
        i = g.next;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === '}') {
      // 多余的右括号（组已被消费）：跳过。
      i++;
      continue;
    }

    if (c === '$') {
      // 残留的 $ 定界符：保留（不应出现在已提取的公式体内，防御性）。
      out += c;
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
