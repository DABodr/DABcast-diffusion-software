# Security policy

## Supported versions

Security fixes go into the latest release only. Installed servers offer it in the web interface
(one-click update), or install it with `sudo dpkg -i dabcast_X.Y.Z_<arch>.deb`.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security** tab of the repository → **Report a vulnerability**.

Include the DABcast version, what an attacker needs (network access, a signed-in session, a
crafted file to import…) and, if possible, the steps to reproduce. You will get an answer as soon
as possible; a fix is published as a new release and credited if you wish.

## Deployment advice

- The web interface is served over plain HTTP: **do not expose port 9090 directly on the
  Internet**. Use it on a trusted network, through a VPN (e.g. `tailscale serve --bg 9090`, which
  gives HTTPS with a valid certificate), or behind a reverse proxy with HTTPS (Caddy, nginx).
- Choose a strong password at the first sign-in (required), and keep the system and DABcast up
  to date.
- Only import configurations (`.json`, `.dct`, `.zip`) that you trust.
