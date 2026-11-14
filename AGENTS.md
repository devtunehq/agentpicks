# packages/agentpicks

The open Agent Picks runner, published to npm as `@devtune/agentpicks`. Read `README.md` first; it is also the package's npm page, so keep maintainer detail here.

## Publishing

- Publish with `pnpm publish` from this directory, never `npm publish`. pnpm applies `publishConfig`, which replaces the source entry points in `exports` with `./package.json` only; npm would publish `./src/*.ts` paths the tarball doesn't contain.
- Check the tarball first with `pnpm pack`: it should hold `dist/cli.js`, its legal notice, `docker/Dockerfile`, `schema/setup.v1.json`, `LICENSE`, `package.json` and `README.md`.

## The GitHub Action

- `action.yml` is the `devtunehq/agentpicks` action: the public mirror holds this directory at its root, so `uses: devtunehq/agentpicks@<ref>` reads this file. It isn't in `files`, so npm never ships it.
- The action runs the CLI version in `package.json` at the ref a workflow uses. Sync the mirror and tag it `v<version>` only after that version is on npm, or the action's `npx` fails.
- The action outputs only `bundle-dir`, with no run link: the CLI's `Upload status:` line is an API v2 address that needs the key, not a page, and parsing the CLI's human-readable lines would make them an interface.
- `src/cli/action.spec.ts` holds `setup` to the setup `run <setup>` takes, and each other input to a `run` flag of the same name that `run <setup>` and `run --category` both accept, or to the DevTune variable `devtune-login.ts` reads. A new `run` flag that suits CI gets an input there too; `--ref` has none, since the checkout chooses the commit.
- `npx` runs outside the checkout, where the CLI finds no setup file by name, so the action resolves a setup path itself and passes any other `setup` as a DevTune setup's name. It refuses a name that is also a file in the checkout's `agentpicks` folder rather than run the DevTune setup in its place.
