import { assessPlanCommandV1 } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("Plan command assessment decodes one quoted inspection argument", () => {
  expect(assessPlanCommandV1("uname '-s'")).toMatchObject({
    policyVersion: "plan-shell-policy.v1",
    disposition: "allow_inspection",
    reasons: ["automatic_system_inspection"],
  });
});

test("Plan command assessment rejects input above the 16 KiB UTF-8 boundary", () => {
  const boundary = [
    "x".repeat(4_096),
    "x".repeat(4_096),
    "x".repeat(4_096),
    "x".repeat(4_093),
  ].join(" ");
  expect(assessPlanCommandV1(boundary)).toMatchObject({
    status: "assessed",
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1(`${boundary}x`)).toMatchObject({
    status: "invalid",
    reasons: ["command_too_large"],
  });
});

test("Plan command assessment enforces segment, argv, token, and Unicode bounds", () => {
  expect(assessPlanCommandV1(Array.from({ length: 32 }, () => "uname -s").join(";"))).toMatchObject(
    {
      status: "assessed",
      disposition: "allow_inspection",
    },
  );
  expect(assessPlanCommandV1(Array.from({ length: 33 }, () => "uname -s").join(";"))).toMatchObject(
    {
      status: "invalid",
      reasons: ["too_many_segments"],
    },
  );
  expect(
    assessPlanCommandV1(["unknown", ...Array.from({ length: 127 }, () => "x")].join(" ")),
  ).toMatchObject({
    status: "assessed",
    disposition: "ask_ambiguous",
  });
  expect(
    assessPlanCommandV1(["unknown", ...Array.from({ length: 128 }, () => "x")].join(" ")),
  ).toMatchObject({
    status: "invalid",
    reasons: ["too_many_arguments"],
  });
  expect(assessPlanCommandV1(`unknown ${"x".repeat(4 * 1024)}`)).toMatchObject({
    status: "assessed",
  });
  expect(assessPlanCommandV1(`unknown ${"x".repeat(4 * 1024 + 1)}`)).toMatchObject({
    status: "invalid",
    reasons: ["token_too_large"],
  });
  expect(assessPlanCommandV1("uname \ud800")).toMatchObject({
    status: "invalid",
    reasons: ["invalid_unicode"],
  });
});

test("Plan command assessment admits an exact two-segment inspection list", () => {
  expect(assessPlanCommandV1("uname -s && uname '-s'")).toMatchObject({
    status: "assessed",
    disposition: "allow_inspection",
    reasons: ["automatic_system_inspection"],
  });
});

test("Plan command assessment hard-denies one output redirect", () => {
  expect(assessPlanCommandV1("uname -s > system.txt")).toMatchObject({
    status: "assessed",
    disposition: "deny_mutation",
    reasons: ["output_redirection"],
  });
});

test("Plan command assessment hard-denies one in-place mutation flag", () => {
  expect(assessPlanCommandV1("sed -i 's/before/after/' README.md")).toMatchObject({
    status: "assessed",
    disposition: "deny_mutation",
    reasons: ["in_place_mutation"],
  });
});

test("Plan command assessment rejects a multiline command before classification", () => {
  expect(assessPlanCommandV1("uname -s\nuname -s")).toMatchObject({
    status: "invalid",
    reasons: ["unsupported_control"],
  });
});

test("Plan command assessment separates malformed commands from unsupported shell syntax", () => {
  for (const command of ["uname '", "uname \\", "uname -s &&", "uname -s;;uname -s"]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "invalid",
      reasons: ["malformed_command"],
    });
  }
  for (const command of [
    "uname < input.txt",
    "uname $HOME",
    "uname $(date)",
    "uname *",
    "VALUE=x uname",
    "uname &",
    "(uname)",
    "uname # comment",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
      reasons: ["unsupported_syntax"],
    });
  }
});

test("Plan command assessment enforces the exact system-observation family", () => {
  for (const command of [
    "uptime",
    "hostname",
    "uname",
    "uname -a",
    "uname -s",
    "uname -r",
    "uname -m",
    "id -u",
    "id -g",
    "id -G",
    "date",
    "date -u",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "allow_inspection",
      reasons: ["automatic_system_inspection"],
    });
  }
  for (const command of ["whoami", "id", "uname -n", "date +%s", "Hostname"]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
    });
  }
});

test("Plan command assessment enforces the exact version-observation family", () => {
  for (const command of ["git --version", "rg --version", "node --version"]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "allow_inspection",
    });
  }
  for (const command of ["git version", "rg -V", "node -v", "node --version extra"]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
    });
  }
});

test("Plan command assessment folds the frozen mutation corpus above ask and allow", () => {
  for (const command of [
    "rm -f result.txt",
    "mkdir generated",
    "mv before after",
    "cp source target",
    "chmod 755 script.sh",
    "ln -s source target",
    "truncate -s 0 output.log",
    "tee output.txt",
    "dd if=input of=output",
    "git add README.md",
    "git stage README.md",
    "git push origin main",
    "git diff --output=report.patch",
    "git update-ref refs/heads/main HEAD",
    "git hash-object -w README.md",
    "git -c core.pager=cat add README.md",
    "git --literal-pathspecs add README.md",
    "git -P add README.md",
    "git format-patch HEAD",
    "npm install package",
    "npm --silent install package",
    "npm --ignore-scripts install package",
    "npm --location=global install package",
    "npm ci",
    "npm rebuild package",
    "npm dedupe",
    "npm prune",
    "pnpm add package",
    "pnpm -w add package",
    "pnpm --offline add package",
    "pnpm -Cadam-agent install package",
    "yarn",
    "cargo --color always install crate",
    "cargo +stable install crate",
    "go get example.com/module",
    "go -C . get example.com/module",
    "sed --in-place=.bak -e s/a/b/ README.md",
    "sed --in-plac=.bak -e s/a/b/ README.md",
    "sed -ni s/a/b/ README.md",
    "sed -Eni s/a/b/ README.md",
    "perl -ni.bak -e s/a/b/ README.md",
    "sort -ooutput README.md",
    "sort -rooutput README.md",
    "sort --out=output README.md",
    "sort --o output README.md",
    'touch "$HOME/forbidden"',
    "uname -s && touch forbidden.txt",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "deny_mutation",
    });
  }
  expect(assessPlanCommandV1("uname -s && unknown --diagnose")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("uname -s | date -u")).toMatchObject({
    disposition: "allow_inspection",
  });
});

test("Plan command assessment hard-denies the frozen npm mutation aliases", () => {
  for (const alias of [
    "rb",
    "ln",
    "it",
    "cit",
    "clean-install",
    "clean-install-test",
    "ic",
    "in",
    "ins",
    "inst",
    "insta",
    "instal",
    "isnt",
    "isnta",
    "isntal",
    "isntall",
    "install-clean",
    "isntall-clean",
    "upgrade",
    "udpate",
    "sit",
    "reb",
    "publi",
    "unpub",
    "prun",
    "install-cl",
    "installTest",
    "create",
    "innit",
  ]) {
    expect(assessPlanCommandV1(`npm ${alias} package`), alias).toMatchObject({
      status: "assessed",
      disposition: "deny_mutation",
    });
  }
  expect(assessPlanCommandV1("npm view isntall")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm verison patch")).toMatchObject({
    disposition: "deny_mutation",
  });
  expect(assessPlanCommandV1("npm version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm u package")).toMatchObject({
    disposition: "ask_ambiguous",
  });
});

test("Plan command assessment classifies mutation only at command-specific positions", () => {
  expect(
    assessPlanCommandV1(
      "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all -- add",
    ),
  ).toMatchObject({ disposition: "allow_inspection" });
  expect(
    assessPlanCommandV1(
      "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all -- --output=report",
    ),
  ).toMatchObject({ disposition: "allow_inspection" });
  expect(assessPlanCommandV1("find . -maxdepth 2 -type f -name -delete -print")).toMatchObject({
    disposition: "allow_inspection",
  });
  expect(assessPlanCommandV1("npm view install")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --timing view install")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --user-agent install --version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --script-shell install --version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --unknown-option --user-agent install --version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  for (const command of [
    "npm --foreground-scripts reb package",
    "npm --foreg reb package",
    "npm --foreground-scripts false reb package",
    "npm --yes false reb package",
    "npm --color reb package",
    "npm --colo reb package",
    "npm --color always reb package",
    "npm -silent reb package",
    "npm -sil reb package",
    "npm -g false publi package",
    "npm -reg=install reb package",
    "npm --user-agent=install reb package",
    "npm --unknown-option=value reb package",
    "npm --no-audit false install package",
    "npm --unknown-option install --version",
    "npm --unknown-option reb package",
    "npm -dD reb package",
    "npm -v false install package",
    "npm -w view install package",
    "npm -cn false install package",
    "npm -ws false install package",
    "npm -z reb package",
    "npm -z false reb package",
    "npm --depth -1 reb package",
    "npm --access -x reb package",
    "npm --yes null reb package",
    "npm --silent=reb package",
    "npm -silent=reb package",
    "npm --no-replace-registry-host null reb package",
    "npm --no-replace-registry-host public reb package",
    "npm --local-address null reb package",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      disposition: "deny_mutation",
    });
  }
  expect(assessPlanCommandV1("npm -reg install --version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --user-ag install --version")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --silent false reb package")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --no-audit false view install")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm -dD view reb")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  for (const command of [
    "npm -v false view install",
    "npm -w install view package",
    "npm -cn false view install",
    "npm -dq false install package",
    "npm -Cw view install package",
    "npm -wc view install package",
    "npm --silent=false reb package",
    "npm -silent=false reb package",
    "npm --heading -- --long reb",
    "npm --heading --- --long reb",
    "npm -au=-- --long reb",
    "npm --unknown-option=--- --long reb",
    "npm --no-replace-registry-host reb package",
    "npm --no-local-address null reb package",
    "npm --local-address install --help",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      disposition: "ask_ambiguous",
    });
  }
  expect(assessPlanCommandV1("git -c add status")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --prefix install view package")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("npm --location install view package")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("cargo --color install metadata")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("go -C get env")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sed -- --in-place=.bak")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sed -e -i README.md")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sed --expression=-i README.md")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sed --express --in-place README.md")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sort -k --output input")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sort --key --output input")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sort --random-source --out=input README.md")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1("sort -- --out=output")).toMatchObject({
    disposition: "ask_ambiguous",
  });
});

test("Plan command assessment never treats a shell builtin, reserved word, or wrapper as external", () => {
  for (const command of [
    "pwd",
    "echo value",
    "printf value",
    "test -f README.md",
    "[ -f README.md ]",
    "true",
    "false",
    "cd .",
    "read value",
    "export VALUE=x",
    "! uname -s",
    "command uname -s",
    "builtin pwd",
    "env uname -s",
    "exec uname -s",
    "xargs uname",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
      reasons: ["shell_builtin_or_indirection"],
    });
  }
});

test("Plan command assessment enforces exact workspace inspection and fallback families", () => {
  for (const command of [
    "ls",
    "ls -1 -- .",
    "ls -a README.md",
    "stat -c '%f %s %Y' -- README.md",
    "head -n 20 -- README.md",
    "tail -n 200 -- README.md",
    "wc -l -- README.md",
    "rg --no-config --no-follow --line-number --fixed-strings -- needle .",
    "rg --no-config --no-follow --line-number --fixed-strings --ignore-case -- needle packages",
    "grep -nF -- needle README.md",
    "grep -nF -i -- needle README.md",
    "find . -maxdepth 2 -type f -name '*.ts' -print",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "allow_inspection",
      reasons: ["automatic_workspace_inspection"],
    });
  }
  for (const command of [
    "ls -l",
    "stat README.md",
    "head -n 0 -- README.md",
    "tail -n 201 -- README.md",
    "wc -L -- README.md",
    "rg --no-config --line-number --fixed-strings -- needle .",
    "grep -R needle .",
    "find . -type f -print",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
    });
  }
});

test("Plan command assessment enforces path operand count and byte bounds", () => {
  expect(
    assessPlanCommandV1(`ls -- ${Array.from({ length: 32 }, (_, index) => `p${index}`).join(" ")}`),
  ).toMatchObject({ status: "assessed", disposition: "allow_inspection" });
  expect(
    assessPlanCommandV1(`ls -- ${Array.from({ length: 33 }, (_, index) => `p${index}`).join(" ")}`),
  ).toMatchObject({ status: "invalid", reasons: ["too_many_paths"] });
  expect(assessPlanCommandV1(`ls -- ${"x".repeat(4 * 1024 + 1)}`)).toMatchObject({
    status: "invalid",
    reasons: ["token_too_large"],
  });
});

test("Plan command assessment enforces every mandatory automatic Git argv family", () => {
  for (const command of [
    "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
    "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all --branch",
    "git --no-pager rev-parse --show-toplevel",
    "git --no-pager rev-parse --is-inside-work-tree",
    "git --no-pager rev-parse --show-prefix",
    "git --no-pager rev-parse --verify HEAD",
    "git --no-pager log --oneline --decorate=no -n 20",
    "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all",
    "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all --name-only --cached -- README.md",
    "git --no-pager show --no-ext-diff --no-textconv --ignore-submodules=all --stat HEAD",
    `git --no-pager show --no-ext-diff --no-textconv --ignore-submodules=all --name-status ${"a".repeat(40)}`,
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "allow_inspection",
      reasons: ["automatic_git_inspection"],
    });
  }
});

test("Plan command assessment admits grep without files only from an automatic pipeline", () => {
  const rg = "rg --no-config --no-follow --line-number --fixed-strings -- needle .";
  expect(assessPlanCommandV1(`${rg} | grep -nF -- needle`)).toMatchObject({
    disposition: "allow_inspection",
    reasons: ["automatic_workspace_inspection"],
  });
  expect(assessPlanCommandV1("grep -nF -- needle")).toMatchObject({
    disposition: "ask_ambiguous",
  });
  expect(assessPlanCommandV1(`${rg} && grep -nF -- needle`)).toMatchObject({
    disposition: "ask_ambiguous",
  });
});

test("Plan command assessment keeps every mandatory Git family near miss ambiguous", () => {
  for (const command of [
    "git status",
    "git --no-pager status --branch --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
    "git --no-pager rev-parse HEAD",
    "git --no-pager log --oneline --decorate=no -n 0",
    "git --no-pager log --oneline --decorate=short -n 20",
    "git --no-pager diff --cached --no-ext-diff --no-textconv --ignore-submodules=all",
    "git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all HEAD",
    "git --no-pager show --no-ext-diff --no-textconv --ignore-submodules=all --stat HEAD~1",
    "git -C .. status",
  ]) {
    expect(assessPlanCommandV1(command), command).toMatchObject({
      status: "assessed",
      disposition: "ask_ambiguous",
    });
  }
});
