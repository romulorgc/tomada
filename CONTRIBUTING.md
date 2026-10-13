# Contributing to Tomada

Contributions are welcome. This page explains how they get in.

## How contributions are accepted

Every change enters through a pull request. Every pull request is reviewed and approved by
the maintainer, [@romulorgc](https://github.com/romulorgc), before it is merged. Nothing is
merged without that review. Reviews are best effort, so please be patient.

Before you start a large change, open an issue and describe it. A short conversation
first saves you from writing something that does not fit the project.

## Contributor License Agreement (CLA)

Tomada is released under the [AGPL-3.0](LICENSE). The maintainer may also license it under
other terms, for example a commercial license. For that to be possible, every contributor
signs the [CLA](CLA.md). You keep the copyright in your work. The CLA gives the maintainer
the right to relicense it.

How to sign:

1. Open your pull request.
2. A bot comments with the CLA link. Post this exact sentence as a comment on the pull
   request:

   `I have read the CLA Document and I hereby sign the CLA`

3. The bot records your signature once. It applies to your later pull requests too.

If the bot is not running (GitHub Actions can be unavailable), do step 2 anyway. The
maintainer reads your comment and checks it by hand before merging.

## Setting up

You need Windows 10 or 11, Node.js 22 or newer, and ffmpeg on your `PATH`.

```bash
npm ci
npm run dev        # starts the app with hot reload
```

Check your work before you open the pull request:

```bash
npm run typecheck  # three tsc projects: main process, renderer and e2e
npm test           # unit and integration tests (vitest)
npm run test:e2e   # builds the app and drives it with Playwright (windows stay hidden)
```

The tests generate their own synthetic media with ffmpeg and the Windows speech synthesizer
(a Brazilian Portuguese voice must be installed). A few tests need an NVIDIA GPU or the
transcription tools prepared by the app. They say so when something is missing.

## Guidelines

- TypeScript is strict. There is no linter yet, so follow the style of the surrounding code.
- Keep one topic per pull request, with a test when the behavior changes.
- Code comments and interface strings are in Portuguese today. An English interface is on the
  roadmap. Issues and pull requests can be written in English or Portuguese.
- Commit messages are short and say what changed.
- Never include real recordings, faces, e-mail addresses or personal data in tests,
  screenshots or issues. Use synthetic media.
- Do not add network calls or telemetry. The app runs on the user's machine and talks only to
  the services listed in the README.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Commercial licensing

To ask about a commercial license, open an issue with the "Commercial license" template.
