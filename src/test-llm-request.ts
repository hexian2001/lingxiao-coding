/**
 * LLM 请求独立测试脚本
 * 测量连接时间、首 token 时间、流式速度
 * 
 * Dev-only: excluded from production/package builds.
 * 用法: npm run dev:test-llm-request
 */

async function main() {
  const { loadSettings } = await import('./config.js');
  const settings = loadSettings();
  
  const apiKey = process.env.OPENAI_API_KEY || '';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = settings.llm?.leader_model || 'gpt-4o';
  
  console.log('=== LLM 请求测试 ===');
  console.log(`Provider: openai`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Model: ${model}`);
  console.log(`API Key: ${apiKey?.slice(0, 10)}...`);
  console.log('');

  // Test 1: DNS 解析
  console.log('[Test 1] DNS 解析...');
  const url = new URL(baseUrl);
  const dnsStart = Date.now();
  try {
    const { resolve } = await import('dns');
    const addresses = await new Promise<string[]>((resolve_, reject) => {
      resolve4(url.hostname, (err, addrs) => {
        if (err) reject(err);
        else resolve_(addrs);
      });
    });
    console.log(`  DNS 解析成功: ${addresses.join(', ')} (${Date.now() - dnsStart}ms)`);
  } catch (e: any) {
    console.log(`  DNS 解析失败: ${e.message} (${Date.now() - dnsStart}ms)`);
  }

  // Test 2: TCP 连接
  console.log('\n[Test 2] TCP 连接...');
  const tcpStart = Date.now();
  try {
    const net = await import('net');
    await new Promise<void>((resolve_, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(10000);
      socket.on('connect', () => { socket.destroy(); resolve_(); });
      socket.on('error', reject);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP timeout')); });
      socket.connect(parseInt(url.port) || 443, url.hostname);
    });
    console.log(`  TCP 连接成功 (${Date.now() - tcpStart}ms)`);
  } catch (e: any) {
    console.log(`  TCP 连接失败: ${e.message} (${Date.now() - tcpStart}ms)`);
  }

  // Test 3: TLS 握手 + HTTP 请求 (non-streaming)
  console.log('\n[Test 3] 非流式请求 (max_tokens=50)...');
  const nonStreamStart = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
        max_tokens: 50,
        stream: false,
      }),
    });
    const ttfb = Date.now() - nonStreamStart;
    console.log(`  HTTP ${res.status} — TTFB: ${ttfb}ms`);
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`  Response: "${content.slice(0, 100)}"`);
    console.log(`  Usage: prompt=${data.usage?.prompt_tokens}, completion=${data.usage?.completion_tokens}`);
  } catch (e: any) {
    console.log(`  请求失败: ${e.message} (${Date.now() - nonStreamStart}ms)`);
  }

  // Test 4: 流式请求
  console.log('\n[Test 4] 流式请求 (max_tokens=100)...');
  const streamStart = Date.now();
  let firstChunkTime = 0;
  let chunkCount = 0;
  let fullContent = '';
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
        max_tokens: 100,
        stream: true,
      }),
    });
    
    console.log(`  HTTP ${res.status} — Headers received: ${Date.now() - streamStart}ms`);
    
    if (!res.ok || !res.body) {
      const text = await res.text();
      console.log(`  Error response: ${text.slice(0, 200)}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (chunkCount === 0) {
        firstChunkTime = Date.now() - streamStart;
        console.log(`  First chunk: ${firstChunkTime}ms`);
      }
      chunkCount++;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          } catch {/* expected: best-effort cleanup */}
        }
      }
    }
    
    console.log(`  Total chunks: ${chunkCount}`);
    console.log(`  Total time: ${Date.now() - streamStart}ms`);
    console.log(`  Response: "${fullContent.slice(0, 200)}"`);
    console.log(`  TTFT: ${firstChunkTime}ms | Tokens/sec: ${fullContent.length > 0 ? (fullContent.length / ((Date.now() - streamStart - firstChunkTime) / 1000)).toFixed(1) : 'N/A'} chars/s`);
  } catch (e: any) {
    console.log(`  流式请求失败: ${e.message} (${Date.now() - streamStart}ms)`);
  }

  // Summary
  console.log('\n=== 诊断结果 ===');
  if (firstChunkTime > 0) {
    if (firstChunkTime > 10000) {
      console.log(`⚠ TTFT 过慢 (${firstChunkTime}ms > 10s) — 可能原因: 模型冷启动、网络延迟高、服务端排队`);
    } else if (firstChunkTime > 3000) {
      console.log(`△ TTFT 偏慢 (${firstChunkTime}ms) — 可能原因: 模型推理预热、网络延迟`);
    } else {
      console.log(`✓ TTFT 正常 (${firstChunkTime}ms)`);
    }
  }
}

function resolve4(hostname: string, callback: (err: Error | null, addresses: string[]) => void) {
  import('dns').then(({ resolve4: _resolve4 }) => _resolve4(hostname, callback)).catch(callback as any);
}

main().catch(console.error);
