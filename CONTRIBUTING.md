# Contributing to DABcast

Thanks for your interest! DABcast runs **on air**: every change can interrupt a live DAB+
broadcast, so the project favours small, well-tested changes over large rewrites.

## Reporting

- **Bugs**: open an issue with the *Bug report* template (version, system, outputs, log lines).
  Remove any private stream URL, token or password first.
- **Hardware feedback** (SDR, modulator, converter): the *Hardware report* template. Only the
  HackRF One and the EasyDAB V2 have been tested on air so far — reports for LimeSDR, BladeRF,
  PlutoSDR or commercial equipment are very welcome.
- **Security issues**: never in a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/DABodr/DABcast-diffusion-software.git
cd DABcast-diffusion-software/server
npm ci
npm start      # http://localhost:9090 (ODR-mmbTools needed to go on air: install-tools.sh)
npm test       # all tests must pass
```

- Node.js 24 (the .deb embeds Node.js 24 too). Backend: Express, ES modules, no TypeScript.
  Frontend: vanilla JavaScript, no framework, no build step in development.
- To try changes beside a running installation, start a second instance with its own data
  directory and port: `DABCAST_DATA_DIR=/path/to/copy node src/index.js` (port in its
  `settings.json`). Never point it at the data of a server that is on air.

## Pull requests

- One subject per pull request, as small as possible; explain what changes and why it is safe
  for a live broadcast.
- Add or update tests (`server/tests/`, Node.js test runner). GitHub Actions runs them on every
  pull request.
- Keep existing behaviour by default: settings and presets written by older versions must keep
  working, `/api/state` changes must be additive.
- Be extra careful with the process management, the watchdog, the generation of the `.mux` and of
  the ODR command lines: test them on real hardware when you change them.
- [CLAUDE.md](CLAUDE.md) describes the architecture and the rules followed so far in detail.

## License

By contributing, you agree that your contribution is released under the
[GNU AGPL v3](LICENSE), like the rest of DABcast.
