```js
import { ethers } from "ethers";
import fs from "fs";

// ====== CONFIG ======
const RPC_URL = process.env.RPC_URL;
const WATCH_ADDRESS_RAW = process.env.WATCH_ADDRESS || "";
const WATCH_ADDRESS = WATCH_ADDRESS_RAW.toLowerCase();
const POLL_MS = Number(process.env.POLL_MS || 12_000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 2); // reorg safety
const START_BLOCK = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null;

if (!RPC_URL) {
  console.error("Missing RPC_URL env var.");
  process.exit(1);
}
if (!ethers.isAddress(WATCH_ADDRESS_RAW)) {
  console.error("WATCH_ADDRESS must be a valid 0x address.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

// High-signal ABIs
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];
const ERC721_ABI = [
  "function setApprovalForAll(address operator,bool approved)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
];

const IFACE_ERC20 = new ethers.Interface(ERC20_ABI);
const IFACE_ERC721 = new ethers.Interface(ERC721_ABI);

const stateFile = `./state-${WATCH_ADDRESS}.json`;
const logFile = `./evidence-${WATCH_ADDRESS}.log`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch { return { lastBlock: 0 }; }
}
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  fs.appendFileSync(logFile, msg + "\n");
}

function classifyCalldata(tx) {
  if (!tx.to || !tx.data || tx.data === "0x") return null;

  // ERC20 approve
  try {
    const decoded = IFACE_ERC20.parseTransaction({ data: tx.data });
    if (decoded?.name === "approve") {
      const spender = decoded.args[0];
      const amount = decoded.args[1];
      return `HIGH-RISK: ERC20 approve(spender=${spender}, amount=${amount.toString()})`;
    }
  } catch {}

  // ERC721/1155 setApprovalForAll
  try {
    const decoded = IFACE_ERC721.parseTransaction({ data: tx.data });
    if (decoded?.name === "setApprovalForAll") {
      const operator = decoded.args[0];
      const approved = decoded.args[1];
      return `HIGH-RISK: setApprovalForAll(operator=${operator}, approved=${approved})`;
    }
  } catch {}

  return null;
}

function summarizeLogs(receipt) {
  // Decode common Transfer events involving WATCH_ADDRESS
  const hits = [];
  for (const lg of receipt.logs || []) {
    // ERC20 Transfer
    try {
      const parsed = IFACE_ERC20.parseLog(lg);
      if (parsed?.name === "Transfer") {
        const from = String(parsed.args.from).toLowerCase();
        const to = String(parsed.args.to).toLowerCase();
        if (from === WATCH_ADDRESS || to === WATCH_ADDRESS) {
          hits.push(`ERC20 Transfer @${lg.address}: from ${parsed.args.from} to ${parsed.args.to} value ${parsed.args.value.toString()}`);
        }
      }
    } catch {}

    // ERC721 Transfer
    try {
      const parsed = IFACE_ERC721.parseLog(lg);
      if (parsed?.name === "Transfer") {
        const from = String(parsed.args.from).toLowerCase();
        const to = String(parsed.args.to).toLowerCase();
        if (from === WATCH_ADDRESS || to === WATCH_ADDRESS) {
          hits.push(`ERC721 Transfer @${lg.address}: from ${parsed.args.from} to ${parsed.args.to} tokenId ${parsed.args.tokenId.toString()}`);
        }
      }
    } catch {}
  }
  return hits;
}

async function main() {
  const state = loadState();

  let lastBlock =
    START_BLOCK ??
    (state.lastBlock && state.lastBlock > 0 ? state.lastBlock : await provider.getBlockNumber());

  log(`Watching ${WATCH_ADDRESS} from block ${lastBlock} | poll=${POLL_MS}ms | conf=${CONFIRMATIONS}`);

  while (true) {
    try {
      const tip = await provider.getBlockNumber();
      const safeTip = tip - CONFIRMATIONS;
      if (safeTip <= lastBlock) {
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }

      for (let b = lastBlock + 1; b <= safeTip; b++) {
        const block = await provider.getBlock(b, true);
        if (!block?.transactions?.length) continue;

        for (const tx of block.transactions) {
          const from = (tx.from || "").toLowerCase();
          const to = (tx.to || "").toLowerCase();
          if (from !== WATCH_ADDRESS && to !== WATCH_ADDRESS) continue;

          const receipt = await provider.getTransactionReceipt(tx.hash);
          const note = classifyCalldata(tx);

          log(`TX ${tx.hash} | block ${b} | from ${tx.from} -> to ${tx.to || "(contract creation)"} | value ${ethers.formatEther(tx.value || 0n)} ETH`);
          if (note) log(`ALERT ${note}`);

          const transfers = summarizeLogs(receipt);
          for (const t of transfers) log(`EVENT ${t}`);
        }
      }

      lastBlock = safeTip;
      saveState({ lastBlock });
    } catch (e) {
      log(`ERROR ${e?.message || String(e)}`);
      // brief backoff on RPC errors
      await new Promise(r => setTimeout(r, Math.min(POLL_MS * 2, 60_000)));
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```
