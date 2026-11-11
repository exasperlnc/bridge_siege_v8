# Bridge Siege V8

Online two-player browser game. Works on desktop and mobile.

```
npm install
npm run dev      # dev: game server on :8787 + Vite on :5173 (open http://localhost:5173)
npm test         # rules engine tests
npm run build && npm start   # production: one server on $PORT (default 8787) serving game + WebSocket
```

To play over the internet, deploy `npm run build && npm start` to any Node host that supports WebSockets
(Render, Fly.io, Railway, a VPS…). Players create a room, share the 5-letter code or link, and the
opponent joins. Refreshing the page rejoins the same seat.

## Layout

- `src/engine/` – pure, deterministic rules (`applyAction(state, player, action)`), shared by client and server.
- `server/server.ts` – authoritative server: rooms, validation, broadcasts. Rooms live in memory.
- `src/client/` – Canvas 2D board + HTML panel.

## Rule clarifications (decided with the designer)

- Board is 12 wide × 15 long. Each castle's 4 gate tiles are the middle 4 cells of its short edge.
- The builder is also the bomber (the bomber piece no longer exists).
- Gate tiles start as open ground; a builder must build onto them to leave the castle.
- A builder moving onto open ground uses 1 stockpile tile; if the stockpile is empty it can't. The mine never runs out.
- Seeker attack targets an enemy on an adjacent tile and moves the seeker onto it, at no movement cost.
- Tower: built on the builder's own tile (2 AP use + 6 AP + 6 tiles). Destroying an adjacent tower costs 2 + 6 AP.
  A builder may move and destroy in the same use.
- Destroy tile: one adjacent tile without a unit on it; one extra tile (+2 AP) adjacent to the first. Max 2 per builder per turn.
- Bridges are supported only by tracing a path of tiles to a gate (either castle). Towers carry the connection
  through but don't act as anchors, and towers never fall.
- A builder building out from an isolated tower must reconnect by the end of its use, or the use can't be finished.
- Siege: an enemy unit in your 4 rows nearest your gate blocks your mining and recruiting. While under siege, having
  no units on the field or in your castle loses the game (a passenger is destroyed along with its mount).
- Units can pass through allies; only a mount and its passenger may share a tile. A mount carries one passenger.
- Recruiting counts toward the 10-recruit limit; retraining doesn't.
- Undo: moves and abilities of the unit currently in use can be undone. Choosing another unit, any castle action,
  or ending the turn finalizes it.
- Siege elimination is checked when a unit use is finalized and at the end of each turn.
