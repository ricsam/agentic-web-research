# agentic-web-research documentation

Mintlify documentation for the project lives in this directory.

## Preview locally

Install Node.js 20.17 or newer and the [Mintlify CLI](https://www.npmjs.com/package/mint), then run:

```bash
npm install --global mint
cd docs
mint dev
```

The preview is available at `http://localhost:3000` by default.

From the repository root you can also run:

```bash
bun run docs:dev
```

## Validate

```bash
cd docs
mint validate
```

Or from the repository root:

```bash
bun run docs:validate
```

## Structure

- `docs.json`: theme, navigation, API reference, and site links
- `index.mdx` and `quickstart.mdx`: introduction and first-run guide
- `guides/`: provider configuration and SSE client guides
- `deployment/`: Docker Compose and Helm installation
- `api-reference/`: API concepts and event contract
- `openapi.json`: OpenAPI 3.1 specification used for generated endpoint pages

## Publish

Create a Mintlify project, connect this GitHub repository, and set the documentation directory to `docs`. After assigning an application domain, update the server URL in `openapi.json` and any production URLs used in examples.
