# Sluice

A Firefox extension that makes every tab disposable. You close all your tabs whenever you step away. Anything you mean to come back to sits in a queue that decays on a schedule, so the queues can't grow into a second backlog.

Status: under construction. The [design](docs/design.md) defines the intended behavior.

## Development

Requires Node 24+ and [Dagger](https://dagger.io) v1.0.0-beta.15 or later.

```sh
npm ci
npm run build      # bundle into dist/
npm run watch      # rebuild on change
npm start          # run Firefox with dist/ loaded as a temporary add-on

dagger check       # unit tests, type check and web-ext lint, in containers
```

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.
