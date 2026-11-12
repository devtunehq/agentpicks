# packages/agentpicks

The open Agent Picks runner, published to npm as `@devtune/agentpicks`. Read `README.md` first; it is also the package's npm page, so keep maintainer detail here.

## Publishing

- Publish with `pnpm publish` from this directory, never `npm publish`. pnpm applies `publishConfig`, which replaces the source entry points in `exports` with `./package.json` only; npm would publish `./src/*.ts` paths the tarball doesn't contain.
- Check the tarball first with `pnpm pack`: it should hold `dist/cli.js`, its legal notice, `docker/Dockerfile`, `LICENSE`, `package.json` and `README.md`.
