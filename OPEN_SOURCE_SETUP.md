# Opening WAR ARENA as MIT open source  -  safe steps

Do these in order. Steps 1-2 are the security-critical part.

## 1. Kill live secrets first
Any key that ever touched this project should be revoked or rotated BEFORE the
repo goes public  -  a public repo's git history is world-readable forever.
- Revoke/rotate the data-provider (GMGN) API key from its dashboard.
- Rotate or revoke the Telegram bot token in BotFather if you are stopping.
- Rotate the Alchemy key; stop/pause Render + Supabase if shutting the service.

## 2. Start a CLEAN git history (recommended over opening the existing repo)
This guarantees no secret hides in an old commit, even one you already "removed".

    cd C:\work\telegram\GMGN\war
    # copy these four files into the repo root first:
    #   README.md  LICENSE  .gitignore  .env.example
    # then reset history:
    Remove-Item -Recurse -Force .git
    git init
    git add .
    git status          # <-- CONFIRM: no .env, no *.bak, no *.b64 listed
    git commit -m "Open-source release (MIT): WAR ARENA structural analysis engine"

If `git status` shows any .env / *.bak / *.b64 / install-*.ps1, STOP and check
.gitignore is in place before committing.

## 3. Create the public repo on GitHub and push
Create a new EMPTY public repo on github.com (no README/license from GitHub  - 
you already have them). Then:

    git branch -M main
    git remote add origin https://github.com/<you>/<repo>.git
    git push -u origin main

## 4. Final public-safety pass
- Open the repo on github.com and search it for: "key", "token", "postgres://",
  "0x", "@"  -  confirm nothing real leaked.
- Delete any leftover .bak files locally so a later commit can't include them.

## 5. Optional polish
- Add repo topics: solana, ethereum, typescript, on-chain-analysis, telegram.
- Add a short description matching the README's first line.
- Pin the README section on design principles  -  it is the most distinctive part.
