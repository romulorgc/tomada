# Security policy

## Supported versions

Tomada is at version 0.1. Only the latest commit on `main` receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open the **Security** tab of this repository and choose
**Report a vulnerability**. Include the steps to reproduce, the Windows version and what an
attacker could do.

If that option is not available, open an issue titled "Security contact request" without any
technical detail. I will answer with a private channel.

I aim to acknowledge a report within 7 days. After a fix is released, you are welcome to be
credited.

## What matters most here

Tomada runs on your own computer and opens no network port. The areas where a bug would
count the most:

- paths and arguments passed to ffmpeg, Python and other child processes;
- the `tomada-media://` protocol and the window navigation rules;
- the IPC channels between the renderer and the main process;
- storage of the optional Anthropic API key (encrypted with Electron safeStorage, which uses
  Windows DPAPI, and never sent to the interface);
- opening project files that come from somebody else.

## Privacy

Recordings, transcripts and settings stay on your machine. The project has no server and no
telemetry. See the Privacy section of the README for the full list of network connections.
