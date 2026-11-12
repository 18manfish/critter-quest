# Critter Quest multiplayer server

A small server that lets several people play Critter Quest together: you see each other walking around,
chat, and battle each other's critters.

## Run it

You need Node.js 18 or newer. Nothing to install.

```
node server.js
```

Then open http://localhost:8080 in two browser windows, or give friends on your network your computer's
address (for example http://192.168.1.20:8080). `PORT=9000 node server.js` uses another port.

Add `?world=anything` to the address to keep a separate world: players only see others in the same world.

## Playing together

- **🌐 Online** opens the player list: set your name and look, chat, and challenge anyone online.
- Walk into another player to battle, wave or walk past them.
- Battles between players use healed copies of both teams and give no EXP, so your save is never changed.
  Wins and losses are counted in the Online panel.

## How it works

Each game sends the server one small presence object: name, look, area, position, lead critter, and,
during a challenge or battle, the choices for each turn. The server checks its size and shape (4 KB at most,
40 messages a second at most per player) and sends everyone in the same world the player list whenever it changes.

Battles run in lockstep: both games receive both teams and a shared random seed, each publishes its choice
for every turn, and both resolve the turn with the same rules and the same random numbers, so both screens
show the same battle. Received teams are rebuilt from species, level and move names, so stats can't be faked.

## On claude.ai

The published game finds other players without this server: claude.ai's shared room plays the server's part
for everyone who has the artifact open. Friends need a claude.ai account and access to the artifact.
