# 🎮 Games — Online Edition

The full games app (Poker, Werewolf/Mafia, Chess, Boxing, and Platform Arena) with **true online multiplayer**:
friends on separate devices join with a 4-letter room code or invite link.

## Play online
1. Open the hosted app (the live preview link, NOT a downloaded file).
2. Scroll to **🌐 Play Online With Friends**, enter your name, pick a game, **Create Online Room**.
3. Share the **room code** or **🔗 Invite link**. Friends open it, enter a name, and **Join Room**.
4. Add bots for empty seats if you like, then the host hits **Start Game**.

### What's online
- **Poker**: 5-Card Draw / Texas Hold'em / Omaha, 2–10 players, bots fill seats, secret cards per player.
- **Werewolf/Mafia**: 5–10 players, secret role per device, night actions & votes on each phone, wolves-only pack chat (server-enforced).
- **Chess**: standard chess (server-validated legal moves, AI seats available) and Chess Royale for 3–5 players. Bots show a five-second thinking countdown before moving.
- **2v2 Boxing**: side-view real-time fights for four players, online teams or bots, quick/heavy punches, blocking, dodging, stamina, five-second respawns, and first team to three knockouts wins.
- **Smash-style combat**: damage percentages, launch knockback, blast zones, 3 stocks, double jumps, shields that break, and a best-of-3 series for team fights.
- **Platform Battle Arena**: 2–8 fighters with bots, side-view platform movement, quick/heavy attacks, blocking/dodging, sword/hammer/blaster pickups, free-for-all or team battles, plus King of the Hill. Hold the centre hill uncontested; first to 60 points wins.
- **Difficulty you choose**: every room has Easy / Normal / Hard / Expert bots with smart catch-up — they ease off while you're losing badly and push harder when you're on a run.
- **Smarter opponents**: poker bots use Monte-Carlo equity (real pot-odds maths), chess bots search deeper with an opening book and endgame awareness, Werewolf bots keep an evidence ledger of who voted with the wolves.
- **Video calls and chat**: a Party panel with room chat, private DMs, groups, and a full-screen Jitsi video call with a fallback link.
- **Animated pixel fighters**: choose from 20 characters. The pack contains 360 transparent animation frames for running, jumping, blocking, punching, and powerful punches, packed into one fast-loading local atlas. Arena jump height is tuned to reach the platforms.
- **Saved usernames and optional Google sign-in**: guest names stay on the device. Add a Google OAuth Client ID to enable Google's official sign-in button and restore the player's Google name/profile picture.

The offline modes from the original app (solo vs AI, pass-and-play, tutorials) still work in the hosted copy too.

## Party communication
- Open **🎉 Party** in an online room for text chat with clickable file/download links.
- Choose **Everyone**, a private one-to-one conversation, or create a private group with selected players. The server filters private messages by recipient.
- Upload a profile picture from the online setup or the Party 📷 button. Images are cropped and resized in the browser before sharing.
- The **Voice & screen** tab opens a private Jitsi Meet room for the game room, so players can talk and share screens from different locations. This requires internet access and microphone/screen permissions.

## Run it yourself
```bash
npm install
npm start   # http://localhost:3000
```
If the preview ever says the game is asleep, ask the host agent to restart the server.
