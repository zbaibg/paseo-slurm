# Live smoke test for `browser_download`

Run after the deployment in `../CHANGE.md`, with the Human's Paseo desktop
client connected. Uses one open-access arXiv PDF; no subscription content.

## Setup

1. Create a **new** agent (tools are bound when an agent is created) with its
   cwd in a fresh temporary directory, for example
   `/home/zbai29/soft/tmp/browser-download-smoke-YYYYMMDD` (create it first).
   Paseo makes that directory a workspace, which `browser_new_tab` and
   `openInNewTab` need.
2. Confirm the tool list has `browser_download`.

## Steps

1. `browser_new_tab` with `url: "https://arxiv.org/abs/1706.03762"`. Keep the
   returned `browserId` as `B`.
2. Independent in-page hash, `browser_evaluate` on `B`:

   ```js
   async () => {
     const r = await fetch("https://arxiv.org/pdf/1706.03762v7", { credentials: "include" });
     const b = await r.arrayBuffer();
     const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
       .map((x) => x.toString(16).padStart(2, "0")).join("");
     return { status: r.status, bytes: b.byteLength, sha256: h, finalUrl: r.url };
   }
   ```

3. `browser_download`:
   `{ "url": "https://arxiv.org/pdf/1706.03762v7", "browserId": "B", "path": "smoke/vaswani2017.pdf", "expectMagic": "%PDF-" }`
4. On the daemon host: `sha256sum smoke/vaswani2017.pdf`, `head -c 5 smoke/vaswani2017.pdf`,
   `pdfinfo smoke/vaswani2017.pdf | grep Pages`.
5. New-tab route: `browser_download`
   `{ "url": "https://arxiv.org/pdf/1706.03762v7", "openInNewTab": true, "path": "smoke/vaswani2017-newtab.pdf", "expectMagic": "%PDF-" }`,
   then `browser_list_tabs` (the extra tab must be gone).
6. Refusals, each must leave no new file:
   - repeat step 3 unchanged → `download_destination_exists`;
   - `{ "url": "https://arxiv.org/abs/1706.03762", "browserId": "B", "path": "smoke/abs.pdf", "expectMagic": "%PDF-" }`
     → `download_magic_mismatch`;
   - `path: "/tmp/outside.pdf"` → `download_destination_denied`.
7. `browser_close_tab` `B`; remove the temporary directory.

## Pass criteria

- Step 2 `status` is 200; step 3 returns `ok`, `hashVerified: true`,
  `httpStatus: 200`, magic matched, and a `bytes` value equal to step 2.
- SHA-256 from step 2, from the tool result and from `sha256sum` are identical;
  the file starts with `%PDF-`; `pdfinfo` reads it.
- Step 5 gives the same SHA-256 and closes its tab.
- Step 6 returns the three codes.
- Record the tool's elapsed time and `chunks` in `../CHANGE.md` (throughput
  through the relay is not measured yet).
