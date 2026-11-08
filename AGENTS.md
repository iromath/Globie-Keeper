This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in the root `app/` directory — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Browser automation (Chrome DevTools MCP)

The MCP is fixed to `--browserUrl http://127.0.0.1:9222`. Chrome 155+ refuses `--remote-debugging-port` on the default profile ("DevTools remote debugging requires a non-default data directory"), so a symlink to the default profile is refused too.

**Never open a second browser.** Always drive the one long-lived instance:

```bash
# only if 127.0.0.1:9222 is not answering
systemd-run --user --unit=chrome-cdp --collect --setenv=DISPLAY=:0 \
  /usr/bin/google-chrome --remote-debugging-port=9222 \
  --user-data-dir=/home/tt/.chrome-keeper --ignore-certificate-errors \
  --no-first-run --no-default-browser-check <url>
```

- Profile: `/home/tt/.chrome-keeper` (holds the Easypanel session and other logins).
- It runs as a systemd user unit, so `nohup`/`setsid` are unnecessary and plain `&` dies with the terminal.
- Check before launching: `curl -s http://127.0.0.1:9222/json/version` — if it answers, just call `list_pages`.

## Hackathon submission (PayPal AI Hackathon)

Deadline **Nov 12, 2026 12:00pm PT** (Nov 13 03:00 ICT); judging Dec 1–15, 2026.
Live: web `https://keeper.globie.ai`, API `https://keeperapi.globie.ai/api` (Docker Compose on Easypanel).
Current blockers: `master` is ahead of `origin/master` (unpushed) and `iromath/Globie-Keeper` is still **private**; the rules require a public repo with the licence visible in About.
Read `SUBMISSION.md` for the full checklist, demo credentials, and Devpost field copy before touching submission work.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
