# OEV v1 Compound Example Bot

A searching bot for a fork of Compound protocol using OEV v1 proxies.

This repository documents the necessary steps to update an MEV bot to an OEV bot. While the main branch is the final
result of the OEV bot, there are branches for the previous steps, so one can easily compare the changes.

## MEV bot

On branch [mev](https://github.com/api3dao/oev-v1-compound-bot/tree/mev)

First step is to have an MEV bot that can perform liquidations when the opportunity to do so arises. For more
information, refer to [OEV Searching](https://docs.api3.org/oev/searchers/).

## MEV with Signed APIs bot

Changes [mev -> mev-with-signed-apis](https://github.com/api3dao/oev-v1-compound-bot/compare/mev...mev-with-signed-apis)

Second step is to extend the MEV bot to utilize the public Base Feed Endpoints. The existing MEV bot can utilize this
off-chain open source data and make a base feed update on-chain whenever there is OEV to be captured. For more
information, refer to [MEV with Signed APIs](https://docs.api3.org/oev/searchers/mev-with-signed-apis.html).

## OEV bot

Changes [mev-with-signed-apis -> oev](https://github.com/api3dao/oev-v1-compound-bot/compare/mev-with-signed-apis...oev)

Final step is to transition to utilizing the OEV network to acquire the exclusive privilege to update the data feeds.
For more information, refer to [OEV Searching](https://docs.api3.org/oev/searchers/oev-searching.html).

## How to

### Preparation

Install node modules.

```bash
pnpm install
pnpm run build
```

### CLI Utils

The bot has a set of CLI commands, executable by

```bash
pnpm run bot:cli-utils <command>
```

where \<command\> can be one of the following:

- `deploy` - This deploys the Liquidator contract, resulting address of which has to be configured in the `.env` file
- `prepare-positions-to-watch` - Prepares positions to watch, continuing from the last block number saved in the
  `all-positions.json` file. More details below in the Bot Concepts section.
- `reset-positions-to-watch` - Similar to `prepare-positions-to-watch`, but it starts from block zero.

### Configuration

All bots require configuration.

Refer to `.env.example` for the .env configuration. Ensure this file has been copied to `.env` and has been configured.
The example ENV file contains recommended ENV variables for the each bot.

### Running the bot

Bot can be run directly with `ts-node` by

```bash
pnpm run bot:run
```

## Bot concepts

There are 2 main folders:

- `contracts` - Smart contracts of necessary Compound V3 and Uniswap V3 interfaces, Multicall3 for batching multiple
  smart contract calls in one transaction, and our Compound3Liquidator.
- `src` - Source code of the bot and stored data.

### Storage

The bot has an in-memory storage, which is defined in the `src/lib/storage.ts`. The storage is initialized when the bot
is started, and keep all the important data for the bot execution. Created are also the corresponding connectors for
contracts the bot will be interacting with.

### Positions tracking

A position in the Compound protocol is simply an address of the borrower - this is the identifier when we want to do a
liquidation call. The position tracking functions are located in `src/lib/positions.ts`.

Pertaining to positions are the storage variables `allPositions`, `currentPositions` and `interestingPositions`.
`allPositions`, as its name might suggest, tracks all of the positions in the Compound protocol that at some point had
executed a `borrow` action at some point. `currentPositions` is a subset of `allPositions`, meaning positions that
currently have an active borrowing position. `interestingPositions` is a subset of `currentPositions`, a position
becomes interesting when it crosses a certain LTV (Loan to Value) threshold.

Since fetching all positions from the beginning of the protocol might take considerable amount of time, there is a file
`all-positions.json` which gets loaded in the bot initialization phase and serves as a checkpoint so that the bot does
not have to fetch the whole history every time it is restarted. The file can be created and updated by running
abovementioned CLI command `prepare-positions-to-watch`.

### Liquidation

Liquidations are made by interacting with our Compound3Liquidator contract. The details depend on the stage of the bot.
The liquidation functions are located in `src/lib/oev-liquidation.ts`.

The process in general is as follows:

1. A list of possible liquidatable positions is filtered from the `interestingPositions` by simulating the liquidations
   on-chain.
2. A liquidation call with the actual liquidatable positions gets constructed.
3. The call is simulated to get the estimated gas limit.
4. The call is submitted to the network.
5. The result is awaited and logged.

### Bot execution

The bot (`src/oev-liquidation.ts`) runs several asynchronous independent loops at different intervals (defined by `.env`
variables) which perform certain tasks. These are:

- `fetch-and-filter-new-positions` - Fetches logs from the last processed block til the current block of the network in
  use. Filters the logs for the `borrow` action and updates `allPositions`. Filters that result based on active borrow
  position and updates `currentPositions`. Filters that result based on LTV values and updates `interestingPositions`.
- `reset-current-positions` - Reevaluates the `currentPositions` from `allPositions` and updates it. Also reevaluates
  the `interestingPositions` from the updated `currentPositions` and updates it.
- `reset-interesting-positions` - Reevaluates the `interestingPositions` from the updated `currentPositions` and updates
  it.
- `initiate-oev-liquidations` - Uses `interestingPositions` to find out any positions that might be able to be
  liquidated. If there are any, it executes the liquidation.
