# Coding Conventions

## Key Principles

- Optimize for reviewability. Names, structure, and control flow should make intent clear.
- Type safety is required. Do not use `any`.
- Prefer simple, obvious code over clever abstractions.
- Documentation is required. Function-level documentation standards live in [DOCUMENTATION.md](./DOCUMENTATION.md).
- Validation, debugging, and execution workflow live in [EXECUTION.md](./EXECUTION.md).
- CLI architecture and behavior live in [CLI.md](./CLI.md).
- Current technology choices and tooling live in [STACK.md](./STACK.md).

## Repository Layout

- Source code lives under `src/`.
- CLI entrypoints live under `src/bin/`.
- Domain constants live under `src/constants/`.
- Reusable application logic lives under `src/lib/`.
- Internal development docs live under `doc/`.
- Scratch files and temporary artifacts should never live in the repository.
- Use `tmp/` (gitignored) or the system temp directory such as `/tmp` for one-off files.

## Modules And Files

- Use named exports only. Do not use default exports.
- Prefer one exported function per file.
- Multiple exported constants in one file are fine when they belong together.
- Name files after the primary exported symbol when practical.
- For exported-function files, use camelCase filenames that match the exported symbol.
- Keep imports static and at the top of the file. Do not use dynamic `import()`.
- Prefer absolute internal imports via `@wiggler/*` instead of deep relative paths.
- Group code by domain (`candles/`, `db/`, `cli/`) rather than by layer.

## Function And API Design

- Prefer object parameters for public functions, even when there is currently only one argument.
- Use explicit return types on exported functions.
- Keep functions small enough that their behavior is obvious without scrolling through unrelated logic.
- If a function needs multiple modes or branches, split it before adding more flags.
- Make invalid states hard to represent through types and schemas rather than defensive comments.

## Code Style

- Prefer early returns over deeply nested conditionals.
- Prefer immutable local values unless mutation materially improves clarity or performance.
- Keep branching and loops straightforward.
- Use comments sparingly. Add them only when the code is not self-explanatory.
- Favor descriptive names over abbreviations.

## Types And Errors

- Start with a Zod schema when data crosses a boundary such as CLI input, config, or external data (Gamma, Polymarket WS, Coinbase, Binance).
- Derive TypeScript types from schemas with `z.infer` when appropriate.
- Prefer narrow unions and specific object types over broad string or record shapes.
- Do not paper over weak typing with `as` casts in normal application flow. Fix the source type inference instead.
- Avoid optional fields unless they are meaningfully optional.
- File-local types that are truly throwaway and only used in one implementation file may stay in that file.
- Types shared within a small, confined area should live in that area's `types.ts`.
- Always store the raw payload alongside any normalized projection. Parser bugs are recoverable when raw events live forever.

## Numbers And Units

- All probability prices are stored as `*_e6` integers (`0.523` -> `523000`).
- All share sizes are stored as `*_e6` integers.
- All underlying-asset prices (BTC/USD, ETH/USD, etc.) are stored as `*_e8` integers.
- Use `priceToE6`, `sizeToE6`, `assetPriceToE8`, and `fromScaledInt` from `@wiggler/lib/domain/decimal`.
- Never operate on probability prices or asset prices as JavaScript `number`s. Use `bigint` end-to-end so we never lose precision.

## Testing

- Every function that can be reasonably unit tested should be.
- Prefer many small, tight, fast unit tests over broad slow tests.
- Tests should be pure and deterministic.
- Isolate or remove dependencies on time, randomness, network access, and other uncontrolled side effects.
- Do not test systems outside the process boundary.
- Do not touch the database in tests.
- Favor direct unit coverage of core logic (slug builders, decimal scaling, book-state application, complement checks) over large integration-style tests.

## Dependencies And Boundaries

- Add dependencies reluctantly. Prefer the standard library or existing repo utilities first.
- Keep boundary code isolated. Validation, parsing, formatting, and IO should not be spread through unrelated business logic.
- Avoid hidden coupling between CLI code and reusable library code.
- Keep logs high signal and error messages actionable.
- For long-running syncs, prefer periodic progress logs (e.g. one per ~10K rows upserted) over per-row log spam.
- Access environment variables through `src/constants/env.ts` so external dependencies stay discoverable in one place. ESLint blocks direct `process.env` reads outside that file.

## CLI Conventions

- User-facing commands should fit the existing `src/bin/` and `src/lib/cli/` structure.
- Command definitions should declare their own metadata, schemas, examples, output, and side effects.
- Shared parsing, completion, help formatting, and error handling should stay in the shared CLI library.
- Command names should be descriptive and stable: `<namespace>:<action>` (e.g. `audit:latest`, `collect:start`).
- Help text, summaries, and usage strings are part of the interface and should be maintained carefully.
- Parse and validate command inputs explicitly (Zod schemas) rather than relying on positional assumptions.
- Error output should be actionable and concise.

## Configuration Style

- One mode by default. No named presets, no `*_ENABLED` toggles for default-on subsystems.
- Configurable where it makes sense (URLs, intervals, symbol lists), with sensible defaults that work without any `.env`.
- Add a flag/env var only when an operator would realistically want to override it. Otherwise hard-code.
