// iOS stand-in for @vscode/ripgrep, which only resolves a prebuilt binary for
// desktop platforms. The path names the in-process shell's rg (runtime/shell.mjs);
// ctx.subprocess runs it by name.
export const rgPath = '/bin/rg';
