# Publish checklist

Audit of `Emmet-v15/one-armed-cake` before switching it from private to public. Done on branch `publish-prep`, 2026-10-03. The repo's visibility has **not** been changed, and no history has been rewritten.

## Verdict

**Nothing secret is in the tree or the history.** There are no tokens, keys, passwords, public IP addresses, real MAC addresses, ISP account details, Wi-Fi names or reflector hostnames. The only identifying items that will become public are the **commit author email** (`emmet@v15.studio`) and some low-risk context such as the timezone and line statistics, listed below. A history rewrite is **optional**. It is only needed if you do not want that email public, and the steps are at the end.

## What was scanned

| check | scope | result |
|---|---|---|
| `gitleaks git . --redact --no-banner` | all commits (3 on `main`, plus the `publish-prep` commits) | no leaks |
| `gitleaks dir . --redact --no-banner` | working tree, including untracked and ignored files | no leaks |
| IPv4 regex over `git log -p --all --text` | full history | only `192.168.1.x` (private LAN), `1.1.1.1` (Cloudflare's public resolver), `0.0.0.0` (bind address) |
| MAC regex over full history | full history | only `00:00:5e:00:53:01` (the RFC 7042 documentation MAC) and `00:00:00:00:00:00` |
| email regex over full history | full history | only the commit author `emmet@v15.studio` (commit metadata, not file content) |
| local paths and usernames (`C:\`, `/home/`, `/Users/`, the local Windows username) | full history and tracked files | none in tracked files |
| ISP, cloud provider, SSID, hostname and token keywords | full history | none, apart from the "Hub" wording below |
| `data/*.jsonl` (56 records) | every key and string value | only condition names, statistics and unix timestamps; no addresses or hostnames |
| `paper/paper.pdf`, `paper/figures/*.pdf`, `*.png` metadata and decompressed streams | binary files | no author field and no local paths. Producer: MiKTeX pdfTeX / Matplotlib. `PTEX.FileName` entries are relative (`./figures/...`) |
| `paper/paper.log`, `paper.aux`, `paper.out` | working tree | `paper.log` contains about 150 local paths that include your Windows username (`C:\Users\<user>\AppData\Local\Programs\MiKTeX\...`). These files are **untracked, gitignored, and in no commit** (`git log --all -- paper/paper.log` is empty) |
| GitHub side (`gh api`) | repo settings | 0 Actions secrets, 0 deploy keys, 0 webhooks, 0 issues/PRs, 0 releases, one branch (`main`) before this work |

## Findings

| # | item | where | risk | action taken |
|---|---|---|---|---|
| 1 | Commit author `Emmet <emmet@v15.studio>` | metadata of every commit, including the ones on this branch | Personal-domain email becomes public and harvestable once the repo is public | **Your decision.** Keep it, or rewrite authorship (steps below) |
| 2 | Commit times (01:31–02:35, `+0100`) and `UTC+1` in `data/README.md` | commit metadata, data README | Reveals your timezone, which is already implied by the measurement dates | none |
| 3 | Private LAN addresses: `192.168.1.1` (ISP router), `.2` (the box), `.100`, `.128`, `.20–.250` (DHCP pool) | docs, config example, paper, a dashboard comment | RFC 1918 addresses, the default for most home routers; reveal nothing | none (they are the documented example config) |
| 4 | "Hub" for the ISP router (e.g. `.1 Hub, .2 Pi`, "heading to the Hub") | `router-shaper` comments and `capan.py` variable names; the old dnsmasq example in history | A slight hint at a UK ISP's router branding. Not account data | Reworded to "ISP router" in the working tree. History keeps the old wording, which does not justify a rewrite |
| 5 | Line diagnostics: ~88 dB downstream attenuation, SNR margins 6.6/5.4 dB, ~5.9/2.0 Mbit/s sync | paper, README | Describes a long DSL line; cannot identify an address or account | none (part of the scientific content) |
| 6 | Testbed description: Pi 4B, Debian 13, Linux 6.18, Windows 11 client, "a cloud VM" reflector (provider unnamed) | paper, docs | none | none |
| 7 | Reflector host | docs, tools | Only the placeholder `reflector.example.com` appears; `exp.py` takes it from `$REFLECTOR` | none |
| 8 | Public download URL `speedtest.tele2.net/100MB.zip` | `tools/exp.py` default | A public test file | none |
| 9 | Name "Emmet" and `github.com/Emmet-v15` | LICENSE, paper, README | Intended attribution | none |
| 10 | LaTeX build logs containing local paths | `paper/paper.log` (untracked) | Only a risk if force-added | Already covered by `.gitignore`. Optionally delete with `git clean -X paper/` |

## Other changes on this branch

- **Bug fix:** `tools/exp.py` turned marking off with `nft flush chain ip mangle forward`. That chain was dropped when everything moved into `table ip one_armed_cake` (commit `1f9f43b`), so on a current install every `*-none` condition would silently have run with marking on. It now flushes `ip one_armed_cake dscp_mark`. The committed data predates the move and is unaffected.
- **Docs now match the code:** the data README documents the `wire_up_mbps` field present in the upload records; the commands list includes `router-shaper down`; the installer options table includes `--low-writes`/`--no-low-writes`; the measurement guide lists matplotlib and says how marking and caps are toggled; `install.sh`'s upgrade warning points to the right doc.
- **Paper:** Figure 1 was about 60 pt wider than its column and drew over the neighboring text, and Table 3 overflowed by about 23 pt. These were fixed with layout-only changes (no text or numbers changed) and `paper.pdf` was rebuilt. `latexmk -pdf paper.tex` builds cleanly with MiKTeX pdfTeX 1.40.28, with no overfull boxes.
- **Reproducibility check:** rerunning `tools/analyze.py` on `data/` reproduces every file in `paper/generated/` exactly.
- **README:** a 30-second summary at the top (problem, result, how, limitations, authorship, stack). It uses only numbers already in the paper. The one wording change is the reflector's idle RTT, which now quotes the paper's 15.9 ms median instead of "16 ms". The technical sections are unchanged. New Authorship and Development sections.
- **CI** (`.github/workflows/ci.yml`): `bash -n` and ShellCheck (error severity) on the shell scripts, `py_compile` on the Python, `bun build` of the dashboard, and the `analyze.py` reproducibility check. There are no unit tests, and CI does not claim any.

## Before flipping to public

1. **Review and merge `publish-prep`** into `main` once CI is green. Open a PR from the branch; nothing has been merged.
2. **Decide on the commit email (finding 1).** If you keep it, do nothing. If you don't want it public, do the rewrite below *before* flipping, and turn on GitHub → Settings → Emails → "Keep my email addresses private" and "Block command line pushes that expose my email".
3. **Confirm the authorship wording** in the README's "In 30 seconds" block and Authorship section: design, measurement and verification by you; implementation AI-assisted. Make sure it reads as accurate to you. It matches the paper's acknowledgment.
4. **Repo settings:** the description still says "Raspberry Pi" (it now runs on any Linux box). Consider "Game-grade latency on a slow DSL line: a one-armed CAKE router for any Linux box, live dashboard, measurement toolkit, and paper". Add topics (`bufferbloat`, `cake`, `traffic-shaping`, `nftables`, `raspberry-pi`, `networking`). Turn off the wiki if you won't use it.
5. **Flip visibility** (Settings → General → Danger zone). Then, signed out or in a private window, check that the README renders, `paper/paper.pdf` opens, the CI badge shows, and `git clone https://github.com/Emmet-v15/one-armed-cake` works anonymously.
6. Optional local cleanup: `git clean -X paper/` removes the ignored LaTeX build files that contain local paths.

## Optional: rewriting the author email (only if you decide to)

This rewrites every commit hash. Nothing else in the history needs removing. Do it before the repo is public, and before anyone else clones it.

```bash
pip install git-filter-repo
ID=$(gh api user --jq .id)                       # your numeric GitHub user id
git clone --mirror https://github.com/Emmet-v15/one-armed-cake.git oac.git
cd oac.git
printf 'Emmet <%s+Emmet-v15@users.noreply.github.com> <emmet@v15.studio>\n' "$ID" > ../mailmap
git filter-repo --mailmap ../mailmap
git log --all --format='%an <%ae> | %cn <%ce>' | sort -u   # expect only the noreply address
# filter-repo removes the origin remote as a safety measure; add it back and push branches and tags
git remote add origin https://github.com/Emmet-v15/one-armed-cake.git
git push --force origin 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

Then re-clone everywhere (the old local clone and the Pi) instead of pulling. Also set `git config --global user.email "$ID+Emmet-v15@users.noreply.github.com"` so new commits use the noreply address. Commits orphaned by the rewrite are visible only to people who already had access, and GitHub eventually garbage-collects them.
