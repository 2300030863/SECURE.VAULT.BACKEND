const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const WebSocket = require("ws");

(async () => {
  const server = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: "5057", HOST: "127.0.0.1" },
  });
  await new Promise((r) => server.stdout.on("data", (d) => d.toString().includes("Running on") && r()));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dqv-exp-"));
  const chrome = spawn(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${dir}`, "--disable-gpu", "about:blank"]
  );
  await new Promise((r) => setTimeout(r, 1500));

  const target = await new Promise((res, rej) =>
    http
      .request("http://127.0.0.1:9335/json/new?about:blank", { method: "PUT" }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => res(JSON.parse(b)));
      })
      .on("error", rej)
      .end()
  );

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const pend = new Map();
  ws.on("message", (m) => {
    const j = JSON.parse(m);
    if (j.id && pend.has(j.id)) {
      pend.get(j.id)(j);
      pend.delete(j.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5057/online-share?backend=http://127.0.0.1:5057/api" });
  await new Promise((r) => setTimeout(r, 1500));

  const ev = (expr) =>
    send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r.result);

  await ev(`(() => {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const res = await origFetch(url, opts);
      if (typeof url === 'string' && url.includes('/online-share/create')) {
        const data = await res.clone().json();
        if (data && data.success) {
          data.expiresAt = new Date(Date.now() + 4500).toISOString();
          return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
        }
      }
      return res;
    };
    const input = document.querySelector('input[type="file"]');
    const file = new File([new Uint8Array(65536)], 'Expiry_Test.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await new Promise((r) => setTimeout(r, 600));
  const hasFile = (await ev("document.body.innerText.includes('Expiry_Test.pdf')"))?.result?.value;
  console.log("Has file:", hasFile);
  assert.strictEqual(hasFile, true, "Expiry_Test.pdf should appear");

  await ev("Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Generate Access Code')).click()");
  let isActive = false;
  for (let i = 0; i < 40; i++) {
    isActive = (await ev("document.body.innerText.toUpperCase().includes('SHARE THIS 6-CHARACTER ACCESS CODE')"))?.result?.value;
    if (isActive) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("Active dashboard:", isActive);
  assert.strictEqual(isActive, true, "Active dashboard should be shown");

  await new Promise((r) => setTimeout(r, 5200));
  const isExpiredBackToIdle = (
    await ev(
      "document.body.innerText.includes('Generate Access Code') && !document.body.innerText.toUpperCase().includes('SHARE THIS 6-CHARACTER ACCESS CODE')"
    )
  )?.result?.value;
  console.log("Expired back to idle:", isExpiredBackToIdle);
  assert.strictEqual(isExpiredBackToIdle, true, "Countdown expiry should auto-terminate session");

  console.log("✅ 3s Browser Countdown Expiration Test Passed!");
  ws.close();
  chrome.kill();
  server.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error("❌ Expiry test failed:", e);
  process.exit(1);
});
