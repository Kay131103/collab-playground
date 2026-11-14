# 🎨 Collab Playground

A realtime collaborative whiteboard **and** code editor. Everyone in a "room" sees your
strokes and keystrokes instantly, with live cursors. Built on [Yjs](https://yjs.dev) CRDTs,
so concurrent edits merge without conflicts.

## Demo (the wow moment)
1. Open the app in one tab → copy the **🔗 Invite** link.
2. Paste it into a second tab (or another browser/device).
3. Draw with both — watch strokes, text and cursors sync live.

## How it works
| Layer | Tech |
|---|---|
| Shared data | Yjs — canvas strokes as `Y.Array`, code as `Y.Text` |
| Same-browser tabs | `BroadcastChannel` (zero infrastructure) |
| Cross-device | `y-webrtc` over WebRTC with public signaling servers |
| Hosting | Any static host (Cloudflare Pages / Netlify / GitHub Pages) |

**Cost:** $0. No server to run or pay for.

## Dev
```bash
npm install
npm run dev      # → http://localhost:5173
```

## Build & deploy
```bash
npm run build    # → dist/
```
Deploy the `dist` folder to Cloudflare Pages (build command `npm run build`, output
directory `dist`). Free subdomain included.

## Notes
- Cross-device sync uses community signaling servers; if they're ever down, tabs in the
  same browser still sync (BroadcastChannel), and you can self-host a signaling server
  for free on Cloudflare Workers.
- Room names are the URL hash — e.g. `/#paint` always joins the "paint" room.
