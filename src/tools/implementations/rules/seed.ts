/**
 * rules/seed.ts — 内置默认规则包（单一事实源：把原本散落在引擎里的硬编码规则
 * 收口到这里）。
 *
 * 规则用 RegExp 字面量定义（零转换），保证外部化前后扫描输出字节级一致。
 * 用户可通过 RuleLoader 的 rulePackPath 提供额外 JSON 规则包，按 id 覆盖/追加。
 *
 * 内容迁移自：
 *   - TreeSitterSecurityEngine.ts 的 SECURITY_RULES（14 条）+ LANGUAGE_CONFIGS（9 语言）
 *   - BughuntScanTools.ts 的 SECURITY_PATTERNS（19 条）
 *
 * P3 将在此之上为部分规则补充 structuralRule / taint 字段（结构化污点）。
 */
import type {
  LanguageConfig,
  SecurityPattern,
  SecurityRule,
  SupportedLanguage,
} from './schema.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 语言配置（9 语言：ast-grep 名 + 扩展名 + 污点 sources/sinks 声明）
// ═══════════════════════════════════════════════════════════════════════════════

export const SEED_LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  javascript: {
    agName: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs'],
    sources: ['req.body', 'req.query', 'req.params', 'req.headers', 'process.env', 'event.body', 'ctx.request.body'],
    sinks: ['eval', 'exec', 'execSync', 'spawn', 'query', 'innerHTML', 'document.write', 'Function', 'setTimeout', 'setInterval'],
  },
  typescript: {
    agName: 'TypeScript',
    extensions: ['.ts', '.mts', '.cts'],
    sources: ['req.body', 'req.query', 'req.params', 'request.body', 'ctx.request', 'event.body'],
    sinks: ['eval', 'exec', 'execSync', 'spawn', 'query', 'innerHTML', 'dangerouslySetInnerHTML', 'Function'],
  },
  python: {
    agName: 'python',
    extensions: ['.py'],
    sources: ['request.form', 'request.args', 'request.json', 'request.data', 'sys.argv', 'input()', 'os.environ'],
    sinks: ['eval', 'exec', 'os.system', 'subprocess.call', 'subprocess.run', 'cursor.execute', 'pickle.loads', 'yaml.load'],
  },
  go: {
    agName: 'go',
    extensions: ['.go'],
    sources: ['r.FormValue', 'r.URL.Query', 'r.Body', 'os.Getenv', 'c.Param', 'c.Query'],
    sinks: ['exec.Command', 'db.Query', 'db.Exec', 'template.HTML', 'fmt.Fprintf', 'os.Remove'],
  },
  java: {
    agName: 'java',
    extensions: ['.java'],
    sources: ['request.getParameter', 'request.getHeader', 'request.getInputStream', 'System.getenv'],
    sinks: ['Runtime.exec', 'ProcessBuilder', 'Statement.execute', 'PreparedStatement', 'Class.forName', 'ObjectInputStream'],
  },
  rust: {
    agName: 'rust',
    extensions: ['.rs'],
    sources: ['std::env::args', 'std::io::stdin', 'Request::body'],
    sinks: ['Command::new', 'std::process::Command', 'unsafe'],
  },
  c: {
    agName: 'c',
    extensions: ['.c', '.h'],
    sources: ['argv', 'getenv', 'fgets', 'scanf', 'gets', 'recv'],
    sinks: ['system', 'exec', 'popen', 'strcpy', 'strcat', 'sprintf', 'gets', 'scanf', 'free'],
  },
  cpp: {
    agName: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    sources: ['argv', 'getenv', 'std::cin', 'recv'],
    sinks: ['system', 'exec', 'popen', 'strcpy', 'strcat', 'sprintf', 'delete', 'free'],
  },
  ruby: {
    agName: 'ruby',
    extensions: ['.rb'],
    sources: ['params', 'request.body', 'ENV', 'ARGV', 'gets'],
    sinks: ['eval', 'exec', 'system', 'send', 'public_send', 'instance_eval', 'class_eval', 'Marshal.load'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ast-grep 多语言 AST 规则（节点 kind 白名单 + 文本正则；OWASP Top 10 + CWE）
// ═══════════════════════════════════════════════════════════════════════════════

export const SEED_RULES: SecurityRule[] = [
  // ── CWE-78: OS Command Injection ──
  {
    id: 'CWE-78', severity: 'CRITICAL', cwe: 'CWE-78', owasp: 'A03:2021',
    title: 'OS Command Injection',
    description: '用户输入直接传入系统命令执行函数',
    languages: ['javascript', 'typescript', 'python', 'go', 'java', 'ruby', 'c', 'cpp'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:exec|execSync|spawn|spawnSync|system|popen|os\.system|subprocess\.(?:call|run|Popen)|Runtime\.exec|Command::new)\s*\(/],
    contextPatterns: [/\$\{.*(?:req|args|params|input|user|query|body|argv)|\+\s*(?:req|args|params|input|user|query|body|argv)/],
  },
  // ── CWE-89: SQL Injection ──
  {
    id: 'CWE-89', severity: 'HIGH', cwe: 'CWE-89', owasp: 'A03:2021',
    title: 'SQL Injection',
    description: '字符串拼接构建 SQL 查询',
    languages: ['javascript', 'typescript', 'python', 'go', 'java', 'ruby'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'template_string', 'call'],
    patterns: [/\b(?:query|execute|raw|exec|cursor\.execute|db\.Query|db\.Exec|Statement\.execute)\b/],
    contextPatterns: [/(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b/i, /\$\{|\+ ?[a-z]|%s|format\(|f['"]/],
  },
  // ── CWE-79: XSS ──
  {
    id: 'CWE-79', severity: 'HIGH', cwe: 'CWE-79', owasp: 'A03:2021',
    title: 'Cross-Site Scripting (XSS)',
    description: '未转义的用户输入插入 HTML',
    languages: ['javascript', 'typescript'],
    nodeKinds: ['assignment_expression', 'call_expression', 'jsx_attribute'],
    patterns: [/\b(?:innerHTML|outerHTML|document\.write|dangerouslySetInnerHTML)\b/],
  },
  // ── CWE-95: Eval Injection ──
  {
    id: 'CWE-95', severity: 'HIGH', cwe: 'CWE-95', owasp: 'A03:2021',
    title: 'Code Injection via eval()',
    description: '动态代码执行（eval/exec/Function）',
    languages: ['javascript', 'typescript', 'python', 'ruby'],
    nodeKinds: ['call_expression', 'function_call', 'call'],
    patterns: [/\b(?:eval|exec|Function|instance_eval|class_eval|module_eval)\s*\(/],
  },
  // ── CWE-22: Path Traversal ──
  {
    id: 'CWE-22', severity: 'HIGH', cwe: 'CWE-22', owasp: 'A01:2021',
    title: 'Path Traversal',
    description: '用户输入用于文件路径操作',
    languages: ['javascript', 'typescript', 'python', 'go', 'java', 'ruby', 'c'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:readFile|writeFile|open|os\.path\.join|filepath\.Join|File\.new|fopen|readFileSync|createReadStream)\b/],
    contextPatterns: [/(?:req\.|params|args|input|user|query|body)/],
  },
  // ── CWE-798: Hardcoded Credentials ──
  {
    id: 'CWE-798', severity: 'HIGH', cwe: 'CWE-798', owasp: 'A07:2021',
    title: 'Hardcoded Credentials',
    description: '代码中硬编码密码/密钥/token',
    languages: ['javascript', 'typescript', 'python', 'go', 'java', 'rust', 'ruby', 'c', 'cpp'],
    nodeKinds: ['variable_declarator', 'assignment_expression', 'assignment', 'short_var_declaration', 'const_declaration', 'init_declarator'],
    patterns: [/(?:password|secret|api_?key|token|auth_?token|private_?key|access_?key)\s*[:=]\s*['"][^'"]{8,}/i],
  },
  // ── CWE-330: Insecure Randomness ──
  {
    id: 'CWE-330', severity: 'MEDIUM', cwe: 'CWE-330', owasp: 'A02:2021',
    title: 'Insecure Randomness',
    description: '使用不安全的随机数生成器用于安全场景',
    languages: ['javascript', 'typescript', 'python', 'java'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:Math\.random|random\.random|Random\(\))\b/],
    contextPatterns: [/(?:token|secret|password|key|salt|nonce|iv|session)/i],
  },
  // ── CWE-611: XXE ──
  {
    id: 'CWE-611', severity: 'HIGH', cwe: 'CWE-611', owasp: 'A05:2021',
    title: 'XML External Entity (XXE)',
    description: 'XML 解析未禁用外部实体',
    languages: ['javascript', 'typescript', 'python', 'java', 'go'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:parseString|XMLParser|DOMParser|DocumentBuilder|xml\.parse|etree\.parse|saxParser|xml2js)\s*\(/],
  },
  // ── CWE-502: Deserialization ──
  {
    id: 'CWE-502', severity: 'CRITICAL', cwe: 'CWE-502', owasp: 'A08:2021',
    title: 'Insecure Deserialization',
    description: '不安全的反序列化操作',
    languages: ['javascript', 'typescript', 'python', 'java', 'ruby'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:unserialize|deserialize|pickle\.loads?|yaml\.(?:load|unsafe_load)|Marshal\.load|ObjectInputStream|readObject)\b/],
  },
  // ── CWE-918: SSRF ──
  {
    id: 'CWE-918', severity: 'HIGH', cwe: 'CWE-918', owasp: 'A10:2021',
    title: 'Server-Side Request Forgery (SSRF)',
    description: '用户输入控制服务端 HTTP 请求目标',
    languages: ['javascript', 'typescript', 'python', 'go', 'java', 'ruby'],
    nodeKinds: ['call_expression', 'function_call', 'method_invocation', 'call'],
    patterns: [/\b(?:fetch|axios|request|http\.get|urllib\.request|net\/http\.Get|HttpClient|open-uri)\b/],
    contextPatterns: [/(?:req\.|params|args|input|user|query|body|\$\{)/],
  },
  // ── CWE-120: Buffer Overflow (C/C++) ──
  {
    id: 'CWE-120', severity: 'CRITICAL', cwe: 'CWE-120', owasp: 'A04:2021',
    title: 'Buffer Overflow',
    description: '不安全的缓冲区操作',
    languages: ['c', 'cpp'],
    nodeKinds: ['call_expression'],
    patterns: [/\b(?:strcpy|strcat|sprintf|gets|scanf)\s*\(/],
  },
  // ── CWE-676: Dangerous Function (C/C++) ──
  {
    id: 'CWE-676', severity: 'MEDIUM', cwe: 'CWE-676', owasp: 'A04:2021',
    title: 'Dangerous Function',
    description: '使用已知不安全的函数',
    languages: ['c', 'cpp'],
    nodeKinds: ['call_expression'],
    patterns: [/\b(?:gets|mktemp|tmpnam|tempnam|realpath)\s*\(/],
  },
  // ── CWE-259: Hardcoded Password (Go specific) ──
  {
    id: 'CWE-259-GO', severity: 'HIGH', cwe: 'CWE-259', owasp: 'A07:2021',
    title: 'Hardcoded Password (Go)',
    description: 'Go 代码中硬编码密码',
    languages: ['go'],
    nodeKinds: ['short_var_declaration', 'var_declaration', 'const_declaration'],
    patterns: [/(?:password|secret|apiKey|token)\s*[:=]\s*"[^"]{6,}"/i],
  },
  // ── Rust unsafe block ──
  {
    id: 'RUST-UNSAFE', severity: 'MEDIUM', cwe: 'CWE-676',
    title: 'Unsafe Block',
    description: 'Rust unsafe 代码块需要人工审查',
    languages: ['rust'],
    nodeKinds: ['unsafe_block'],
    patterns: [/unsafe/],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 内建 OWASP 正则规则（零依赖，始终可用；迁移自 BughuntScanTools）
// ═══════════════════════════════════════════════════════════════════════════════

export const SEED_PATTERNS: SecurityPattern[] = [
  // SQL 注入
  { id: 'SQL-INJ', severity: 'HIGH', rule: 'sql-injection', message: '可能的 SQL 注入：字符串拼接构建 SQL 查询',
    pattern: /(?:query|execute|raw)\s*\(\s*[`'"](?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b[^`'"]*\$\{/gi, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-89', owasp: 'A03:2021' },
  { id: 'SQL-INJ-2', severity: 'HIGH', rule: 'sql-injection-concat', message: '可能的 SQL 注入：+ 拼接构建 SQL',
    pattern: /(?:query|execute|raw)\s*\(\s*['"](?:SELECT|INSERT|UPDATE|DELETE)\b[^'"]*['"]\s*\+/gi, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-89', owasp: 'A03:2021' },
  // 命令注入
  { id: 'CMD-INJ', severity: 'CRITICAL', rule: 'command-injection', message: '可能的命令注入：exec/execSync 使用模板字符串或拼接',
    pattern: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-78', owasp: 'A03:2021' },
  { id: 'CMD-INJ-2', severity: 'CRITICAL', rule: 'command-injection-concat', message: '可能的命令注入：exec 使用字符串拼接',
    pattern: /(?:exec|execSync)\s*\(\s*[^,)]*\+\s*(?:req\.|args|params|input|user)/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-78', owasp: 'A03:2021' },
  // XSS
  { id: 'XSS-1', severity: 'HIGH', rule: 'xss-innerhtml', message: 'XSS 风险：使用 innerHTML 赋值',
    pattern: /\.innerHTML\s*=\s*(?!['"`]<)/g, fileExts: ['.ts', '.js', '.tsx', '.jsx'], cwe: 'CWE-79', owasp: 'A03:2021' },
  { id: 'XSS-2', severity: 'HIGH', rule: 'xss-dangerously', message: 'XSS 风险：dangerouslySetInnerHTML',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/g, fileExts: ['.tsx', '.jsx'], cwe: 'CWE-79', owasp: 'A03:2021' },
  // 不安全的 eval
  { id: 'EVAL-1', severity: 'HIGH', rule: 'unsafe-eval', message: '不安全的 eval() 调用',
    pattern: /\beval\s*\(/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-95', owasp: 'A03:2021' },
  { id: 'EVAL-2', severity: 'MEDIUM', rule: 'unsafe-function-constructor', message: '不安全的 Function() 构造器',
    pattern: /new\s+Function\s*\(/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-95', owasp: 'A03:2021' },
  // 路径遍历
  { id: 'PATH-1', severity: 'HIGH', rule: 'path-traversal', message: '可能的路径遍历：用户输入直接拼接路径',
    pattern: /(?:readFile|writeFile|createReadStream|access|stat|unlink|rmdir)\w*\s*\(\s*(?:req\.|args|params|input)/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-22', owasp: 'A01:2021' },
  { id: 'PATH-2', severity: 'MEDIUM', rule: 'path-traversal-join', message: '路径拼接未验证：join 使用用户输入',
    pattern: /(?:path\.)?(?:join|resolve)\s*\([^)]*(?:req\.|args\.|params\.|input|user)/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-22', owasp: 'A01:2021' },
  // 硬编码密钥
  { id: 'SECRET-1', severity: 'HIGH', rule: 'hardcoded-secret', message: '硬编码密钥/密码',
    pattern: /(?:password|secret|api_?key|token|auth)\s*[:=]\s*['"][^'"]{8,}['"]/gi, fileExts: ['.ts', '.js', '.mjs', '.json', '.env'], cwe: 'CWE-798', owasp: 'A07:2021' },
  { id: 'SECRET-2', severity: 'MEDIUM', rule: 'hardcoded-jwt', message: '硬编码 JWT/Bearer token',
    pattern: /['"](?:eyJ[A-Za-z0-9_-]+\.eyJ|Bearer\s+[A-Za-z0-9_-]{20,})['"]/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-798', owasp: 'A07:2021' },
  // 不安全的随机数
  { id: 'RAND-1', severity: 'MEDIUM', rule: 'insecure-random', message: '不安全的随机数：Math.random() 用于安全场景',
    pattern: /(?:token|secret|password|key|salt|nonce|iv)\s*=.*Math\.random/gi, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-330', owasp: 'A02:2021' },
  // 未验证的重定向
  { id: 'REDIR-1', severity: 'MEDIUM', rule: 'open-redirect', message: '可能的开放重定向',
    pattern: /(?:redirect|location)\s*[=(]\s*(?:req\.|args|params|query)/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-601', owasp: 'A01:2021' },
  // 不安全的 CORS
  { id: 'CORS-1', severity: 'MEDIUM', rule: 'cors-wildcard', message: 'CORS 配置使用通配符 *',
    pattern: /['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/g, fileExts: ['.ts', '.js', '.mjs'] },
  // 原型污染
  { id: 'PROTO-1', severity: 'HIGH', rule: 'prototype-pollution', message: '可能的原型污染：动态属性赋值',
    pattern: /\[(?:key|prop|name|attr|field)\]\s*=/g, fileExts: ['.ts', '.js', '.mjs'], cwe: 'CWE-1321', owasp: 'A08:2021' },
  // 不安全的反序列化
  { id: 'DESER-1', severity: 'HIGH', rule: 'unsafe-deserialize', message: '不安全的反序列化',
    pattern: /(?:unserialize|deserialize|yaml\.load|pickle\.loads)\s*\(/g, fileExts: ['.ts', '.js', '.py'], cwe: 'CWE-502', owasp: 'A08:2021' },
  // 敏感信息泄露
  { id: 'LEAK-1', severity: 'MEDIUM', rule: 'sensitive-log', message: '可能泄露敏感信息到日志',
    pattern: /console\.(?:log|info|warn|error)\s*\([^)]*(?:password|secret|token|key|credential)/gi, fileExts: ['.ts', '.js', '.mjs'] },
  // 不安全的 HTTP
  { id: 'HTTP-1', severity: 'LOW', rule: 'insecure-http', message: '使用不安全的 HTTP（非 HTTPS）',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/g, fileExts: ['.ts', '.js', '.mjs'] },
];
