---
name: ios-environment
description: This session runs inside an iOS app, not on a desktop, and many commands do not exist. Load this skill before relying on a shell command you are unsure of, whenever one fails or behaves unexpectedly, and before writing or changing a DSH plugin, because the app's native interface does not run a plugin's browser code.
---

# Working on iOS

You are running inside an iOS app. iOS allows no child processes, so nothing here is a real Unix system: `bash` is an emulator written in JavaScript, and every command below runs inside the app. Your own tools (read, write, edit, search) work normally. This page is about the shell, and what the app can show of a DSH plugin.

Check here before improvising, and do not retry a command this page says is missing. Installing it will not work either: there is no `apt`, `brew`, or `sudo`, and iOS refuses to run downloaded binaries.

## Commands that exist

Anything not listed here should be assumed missing.

- **Files:** `ls cat cp mv rm mkdir rmdir touch ln chmod stat file du tree find readlink basename dirname mktemp`
- **Text:** `grep egrep fgrep rg sed awk cut sort uniq wc head tail tr tee paste join comm column fold expand unexpand nl rev tac seq printf echo strings od diff split`
- **Data:** `jq yq xan html-to-markdown base64 md5sum sha1sum sha256sum`
- **Archives:** `tar gzip gunzip zcat`
- **Network:** `curl`
- **Development:** `git node pnpm pnpx`
- **Shell:** `bash sh env printenv which type command date sleep timeout time xargs yes true false expr whoami hostname pwd history alias unalias clear help`

## Missing, and what to do instead

| Missing | Use instead |
|---|---|
| `npm`, `npx`, `yarn`, `corepack` | `pnpm`, `pnpx` |
| `bun`, `deno` | `node` |
| `tsc`, `tsx` | `node file.ts` runs TypeScript directly. For a real compile, `pnpm add -D typescript@5` and run `node_modules/.bin/tsc`. TypeScript 7 is native and does not run |
| `python`, `python3`, `pip`, `ruby`, `perl`, `php`, `lua` | Write the script in Node |
| `gcc`, `clang`, `make`, `cmake`, `cargo`, `go`, `java`, `swift` | Nothing compiles here. Say so, and leave the build to another machine |
| `zip`, `unzip`, `7z`, `xz`, `bzip2` | `tar` and `gzip`, or an npm package such as `fflate` |
| `wget` | `curl` |
| `ssh`, `scp`, `rsync`, `nc`, `ping` | `curl` for HTTP(S). There is no other way to reach a remote machine |
| `uname` | `node -p "process.platform + ' ' + process.arch"` |
| `ps`, `kill`, `killall`, `jobs`, `nohup`, `top`, `lsof`, `df`, `free`, `id` | No equivalent: there is no process table. `timeout <seconds> <command>` bounds a command you are unsure will finish |
| `vim`, `nano`, `less`, `man` | Your file tools for editing; `head` and `sed -n` for reading; `<command> --help` for usage |
| `gh`, `docker` | The GitHub REST API through `curl`. Containers are not possible |
| `sudo`, `su`, `chown`, `apt`, `brew` | Not possible and not needed: you own everything you can write to |
| `sqlite3` | Exists but fails on iOS. Use `node:sqlite` from Node |

## Shell behaviour

Pipes, redirects, `&&`, `||`, variables, arrays, functions, loops, here-documents, `$(...)`, subshells and `[[ ]]` work. Plain bash scripts run. The differences that matter:

- **No live output.** A command's output appears only when it finishes. A single `node` or `pnpm run` command is the exception and streams.
- **Nothing is interactive.** There is no TTY. Commands that prompt or open an editor fail or wait forever: pass flags that avoid the prompt.
- **`trap` does nothing.** It is accepted, but no signal arrives and `EXIT` traps do not run. Do not rely on them for cleanup.
- **Heavy shell work blocks the app.** The interpreter shares a thread with the agent. Long `while` loops or a big `sort` or `rg` freeze everything until they finish. Do heavy work in a Node script: it runs on its own thread.
- **`&` does not detach.** The shell returns only after background jobs finish, so `server & curl localhost` still waits for `server`, and nothing survives the command. `wait` works.
- **Run scripts with their interpreter.** `./tool.js` works only as a whole command on its own: in `./tool.js && next`, or in a pipe, the shell tries to parse it as bash and fails. Write `node tool.js`. Scripts in other languages do not run.
- **`xargs` is limited.** `xargs -n 1 cmd` works (with the space); `-n1` and `-I{}` do not. Use a `for` loop when you need placeholders.
- **Reduced file metadata.** `ls -l` may show placeholder owners and dates, and `/dev/urandom` and `/etc` do not exist. Use `node:crypto` for random bytes.

## Files

- `$HOME` is `/home/dsh` and `$TMPDIR` is `/tmp`. Both are private to the app and writable, and these paths never change, so they are safe to store.
- The first-use workspace is under `~/Documents`. Workspaces are not visible in the Files app.
- `/` is the app's own tree: `home`, `tmp`, `opt`, plus anything you create. Writing to `/abc` or `/usr/local` works and stays inside the app.
- `/etc`, `/usr/share` and `/System` are the real system and read-only. `/opt/dsh` is the app itself and read-only.
- `/bin` and `/usr/bin` exist only in the shell, for its commands. A Node script does not see them.

## Node

Node 24 runs in jitless mode: pure JavaScript is several times slower than on a desktop, and most work is unaffected.

- `child_process` works, but it reaches this same emulated shell. Only the commands on this page can be spawned.
- `http.createServer` works, and dev servers listen on `127.0.0.1`.
- WebAssembly works but runs interpreted, so wasm tools are slow.
- A plain `node` script can use the filesystem, network, `node:sqlite` and worker threads, and `node file.ts` runs TypeScript.

## Packages

- `pnpm add`, `pnpm install`, `pnpm run` and `pnpx` work, and pure JavaScript packages are fine. `pnpm add` creates `package.json` if there is none.
- **Do not run `pnpm init`, and remove a `packageManager` field.** With that field in `package.json` every pnpm command fails with "ships no native binary for ios-arm64". `pnpm init` writes it, and many projects already have it. Delete the field (tell the user you did), and pnpm works again.
- **Packages with native binaries do not work.** Anything shipping a `.node` addon or a platform executable (`esbuild`, `sharp`, `better-sqlite3`, `swc`, Turbopack, TypeScript 7) installs but fails when used, typically with "Unsupported platform: ios arm64". Say so instead of retrying. Next.js needs `next dev --webpack`; `esbuild-wasm` does not work either, because it needs a child process.
- **A DSH plugin's Host code gets a partial `sharp`.** Inside the engine `sharp` is a stand-in over iOS's ImageIO: `metadata()`, `rotate()` with no arguments, `resize({ width, height, fit: 'inside', withoutEnlargement })`, `toColourspace('srgb')`, `jpeg({ quality })`, `raw()`, `clone()` and `toBuffer()`, on Buffer input. Anything else, including WebP and PNG output, throws `sharp: … is not supported on iOS`. It reports `hasAlpha: false` for every image and flattens transparency onto white. A plain `node` script does not get it.
- Install scripts do not run. `pnpm` may print `ERR_PNPM_IGNORED_BUILDS` afterwards: the package is still installed.

## DSH plugins

The app has two interfaces onto the same engine and profile. The user normally works in the **native interface**, built in SwiftUI. The **web interface** is the official DSH Web UI, opened from Settings → 网页版. A plugin does not reach both in the same way:

| Part of a plugin | Native interface | Web interface |
|---|---|---|
| Host half: what runs in the engine, such as tools and settings | Works | Works |
| Browser half: `dsh.client` in `package.json`, the `./client` export, slots such as `sidebar.panellist` and `main`, React pages and panels | **Never runs** | Works |

- **A plugin that only adds interface is invisible in the native interface.** No sidebar entry, panel, or custom page appears there. Its card still shows under 插件 as installed and running, because the engine did load it.
- **Say this before building it.** If the user asks for something they will see, tell them first that a browser half appears only under Settings → 网页版. If it must work in the native interface, put the feature in the Host half instead: a tool the agent can call.
- **Report where it appears.** Being in the profile, loading in the engine, or working in a web page does not show that it appears in the native interface. Name the interface you checked, and do not say a plugin's interface is in the app without saying it is the web interface.
- **`localStorage` belongs to the web interface.** Data a browser half keeps there never reaches the engine or the native interface.
- **Dynamic Cordis plugins** with Client code cannot be activated from the native interface. Define a Host-only version, or run it from the web interface.

## git

`git` is built in, on libgit2. Its output matches real git, so read it as usual.

**Works:** `init clone fetch pull push status add rm mv commit log show diff rev-list shortlog diff-tree branch checkout switch restore reset merge tag stash clean apply remote ls-remote worktree config rev-parse ls-files ls-tree cat-file write-tree check-ignore hash-object merge-base show-ref symbolic-ref check-ref-format`

**Not available:**

| Command | Use instead |
|---|---|
| `rebase` | `git merge`, or `git pull --no-rebase` |
| squashing history | `git reset --soft <base>`, then `git commit` |
| `cherry-pick` | `git diff <commit>~1 <commit> \| git apply --index`, then `git commit` |
| `revert` | Undo the change in the files and commit |
| `blame` | `git log -p -- <file>` |
| `git grep` | `rg` |
| `bisect`, `submodule`, `am`, `format-patch`, `reflog`, `describe` | Not available |

**Rules:**

- Always pass `-m` or `-F` to `commit` and `tag -a`: there is no editor. `commit --amend` and `--no-edit` reuse the existing message, and concluding a merge reuses `MERGE_MSG`.
- Nothing interactive: no `add -p`, `rebase -i`, or `checkout -p`.
- Remotes are **HTTPS only**. Rewrite `git@github.com:a/b.git` as `https://github.com/a/b.git`. SSH cannot work here.
- Set an identity before the first commit: `git config --global user.name "…"` and `user.email`.
- For private repositories, credentials come from the URL, from `~/.git-credentials` (`https://user:token@host` lines), or from `GH_TOKEN` / `GITHUB_TOKEN` for github.com. Nothing prompts for them.
- `log --graph` draws a single column, and no branch lines. Submodules are not cloned.
- Large clones take a while and print nothing until they finish.

## Not possible at all

Tell the user plainly rather than attempting these: compiling native code, running containers or virtual machines, starting system services, background daemons that outlive the app, controlling other apps, or anything needing root. Work that needs them belongs on another machine.
