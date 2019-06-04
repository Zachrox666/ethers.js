"use strict";

import fs from "fs";

import { ethers } from "ethers";

import { getChoice, getPassword, getProgressBar } from "./prompt";

class UsageError extends Error { }


/////////////////////////////
// Signer

const signerFuncs = new WeakMap();
const signers = new WeakMap();
const alwaysAllow = new WeakMap();

// Gets a signer or lazily request it if needed, possibly asking for a password
// to decrypt a JSON wallet
async function getSigner(wrapper: WrappedSigner): Promise<ethers.Signer> {
    if (!signers.has(wrapper)) {
        let signerFunc: () => Promise<ethers.Signer> = signerFuncs.get(wrapper);
        let signer = await signerFunc();
        signers.set(wrapper, signer);
    }
    return signers.get(wrapper);
}

// Throws an error if the user does not allow the operation. If "y" is
// selected, all future operations of that type are automatically accepted
async function isAllowed(wrapper: WrappedSigner, message: string): Promise<boolean> {
    if (wrapper.plugin.yes) {
        console.log(message + " (--yes => \"y\")");
        return true;
    }

    let allowed = alwaysAllow.get(wrapper) || { };
    if (allowed[message]) {
        console.log(message + " (previous (a)ll => \"y\")");
        return true;
    }

    try {
        let allow = await getChoice(message, "yna", "n");
        if (allow === "a") {
            allowed[message] = true;
            alwaysAllow.set(wrapper, allowed);
        } else if (allow === "n") {
            throw new Error("Cancelled.");
        }
    } catch (error) {
        throw new Error("Cancelled.");
    }

    return true;
}

function repeat(chr: string, length: number): string {
    let result = chr;
    while (result.length < length) { result += result; }
    return result.substring(0, length);
}

// @TODO: Make dump recurable for objects

// Dumps key/value pairs in a nice format
export function dump(header: string, info: any): void {
    console.log(header);
    let maxLength = Object.keys(info).reduce((maxLength, i) => Math.max(maxLength, i.length), 0);
    for (let key in info) {
        let value = info[key];
        if (Array.isArray(value)) {
            console.log("  " + key + ":");
            value.forEach((value) => {
                console.log("    " + value);
            });
        } else {
            console.log("  " + key + ":" + repeat(" ", maxLength - key.length) + "  " + info[key]);
        }
    }
}

// This wraps our signers to prevent the private keys and mnemonics from being exposed.
// It is also in charge of user-interaction, requesting permission before signing or
// sending.
class WrappedSigner extends ethers.Signer {
    readonly addressPromise: Promise<string>;
    readonly provider: ethers.providers.Provider;
    readonly plugin: Plugin;

    constructor(addressPromise: Promise<string>, signerFunc: () => Promise<ethers.Signer>, plugin: Plugin) {
        super();
        signerFuncs.set(this, signerFunc);
        ethers.utils.defineReadOnly(this, "addressPromise", addressPromise);
        ethers.utils.defineReadOnly(this, "provider", plugin.provider);
        ethers.utils.defineReadOnly(this, "plugin", plugin);
    }

    connect(provider?: ethers.providers.Provider): ethers.Signer {
        throw new Error("unsupported for now...");
        //return new WrappedSigner(this.addressPromise, () => getSigner(this).then((s) => s.connect(provider)), provider);
    }

    async getAddress(): Promise<string> {
        return this.addressPromise;
    }

    async signMessage(message: string | ethers.utils.Bytes): Promise<string> {
        let signer = await getSigner(this);

        let info: any = { };
        if (typeof(message) === "string") {
            info["Message"] = JSON.stringify(message);
            info["Message (hex)"] = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(message));
        } else {
            let bytes = ethers.utils.arrayify(message);
            for (let i = 0; i < bytes.length; i++) {
                let c = bytes[i];
                if (c < 32 || c > 126) {
                    bytes = null;
                    break;
                }
            }
            if (bytes) {
                info["Message"] = ethers.utils.toUtf8String(bytes);
            }
            info["Message (hex)"] = ethers.utils.hexlify(message);
        }

        dump("Message:", info);

        await isAllowed(this, "Sign Message?");

        let result = await signer.signMessage(message)

        let signature = ethers.utils.splitSignature(result);
        dump("Signature", {
            Flat: result,
            r: signature.r,
            s: signature.s,
            vs: signature._vs,
            v: signature.v,
            recid: signature.recoveryParam,
        });

        return result;
    }

    async signTransaction(transactionRequest: ethers.providers.TransactionRequest): Promise<string> {
        let signer = await getSigner(this);

        let network = await this.provider.getNetwork();

        let tx = await ethers.utils.resolveProperties(transactionRequest);

        let info: any = { };
        if (tx.to != null) { info["To"] = tx.to; }
        if (tx.from != null) { info["From"] = tx.from; }
        info["Value"] = (ethers.utils.formatEther(tx.value || 0) + " ether");
        if (tx.nonce != null) { info["None"] = tx.nonce; }
        info["Gas Limit"] = ethers.BigNumber.from(tx.gasLimit || 0).toString();
        info["Gas Price"] = (ethers.utils.formatUnits(tx.gasPrice || 0, "gwei") + " gwei"),
        info["Chain ID"] = (tx.chainId || 0);
        info["Data"] = ethers.utils.hexlify(tx.data || "0x");
        info["Network"] = network.name;

        dump("Transaction:", info);

        await isAllowed(this, "Sign Transaction?");

        let result = await signer.signTransaction(transactionRequest);

        let signature = ethers.utils.splitSignature(result);
        dump("Signature:", {
            Signature: result,
            r: signature.r,
            s: signature.s,
            vs: signature._vs,
            v: signature.v,
            recid: signature.recoveryParam,
        });

        return result;
    }

    async sendTransaction(transactionRequest: ethers.providers.TransactionRequest): Promise<ethers.providers.TransactionResponse> {
        let signer = await getSigner(this);

        let network = await this.provider.getNetwork();

        let tx: any = await signer.populateTransaction(transactionRequest);
        tx = await ethers.utils.resolveProperties(tx);

        let info: any = { };
        if (tx.to != null) { info["To"] = tx.to; }
        if (tx.from != null) { info["From"] = tx.from; }
        info["Value"] = (ethers.utils.formatEther(tx.value || 0) + " ether");
        if (tx.nonce != null) { info["None"] = tx.nonce; }
        info["Gas Limit"] = ethers.BigNumber.from(tx.gasLimit || 0).toString();
        info["Gas Price"] = (ethers.utils.formatUnits(tx.gasPrice || 0, "gwei") + " gwei"),
        info["Chain ID"] = (tx.chainId || 0);
        info["Data"] = ethers.utils.hexlify(tx.data || "0x");
        info["Network"] = network.name;

        dump("Transaction:", info);

        await isAllowed(this, "Send Transaction?");

        let response = await signer.sendTransaction(tx);

        dump("Response:", {
            "Hash": response.hash
        });

        return response;
    }

    async unlock(): Promise<void> {
        await getSigner(this);
    }
}


/////////////////////////////
// Argument Parser

export class ArgParser {
    readonly _args: Array<string>
    readonly _consumed: Array<boolean>

    constructor(args: Array<string>) {
        ethers.utils.defineReadOnly(this, "_args", args);
        ethers.utils.defineReadOnly(this, "_consumed", args.map((a) => false));
    }

    _finalizeArgs(): Array<string> {
        let args = [ ];
        for (let i = 0; i < this._args.length; i++) {
            if (this._consumed[i]) { continue; }

            let arg = this._args[i];

            // Escaped args, add the rest as args
            if (arg === "--") {
               for (let j = i + 1; j < this._args.length; j++) {
                   args.push(this._args[j]);
               }
               break;
            }

            if (arg.substring(0, 2) === "--") {
                throw new UsageError(`unexpected option ${arg}`);
            }

            args.push(arg);
        }
        return args;
    }

    _checkCommandIndex() {
        for (let i = 0; i < this._args.length; i++) {
            if (this._consumed[i]) { continue; }
            return i;
        }
        return -1;
    }

    consumeFlag(name: string): boolean {
        let count = 0;
        for (let i = 0; i < this._args.length; i++) {
            let arg = this._args[i];
            if (arg === "--") { break; }
            if (arg === ("--" + name)) {
                count++;
                this._consumed[i] = true;
            }
        }

        if (count > 1) {
            throw new UsageError("expected at most one --${name}");
        }

        return (count === 1);
    }

    consumeMultiOptions(names: Array<string>): Array<{ name: string, value: string }> {
        let result: Array<{ name: string, value: string }> = [ ];

        if (typeof(names) === "string") { names = [ names ]; }

        for (let i = 0; i < this._args.length; i++) {
            let arg = this._args[i];
            if (arg === "--") { break; }
            if (arg.substring(0, 2) === "--") {
                let name = arg.substring(2);
                let index = names.indexOf(name);
                if (index < 0) { continue; }

                if (this._args.length === i) {
                    throw new UsageError("missing argument for --${name}");
                }
                this._consumed[i] = true;
                result.push({ name: name, value: this._args[++i] });
                this._consumed[i] = true;
            }
        }

        return result;
    }

    consumeOptions(name: string): Array<string> {
        return this.consumeMultiOptions([ name ]).map((o) => o.value);
    }

    consumeOption(name: string): string {
        let options = this.consumeOptions(name);
        if (options.length > 1) {
            throw new UsageError(`expected at most one --${name}`);
        }
        return (options.length ? options[0]: null);
    }
}

// Accepts:
//   - "-" which indicates to read from the terminal using prompt (which can then be any of the below)
//   - JSON Wallet filename (which will require a password to unlock)
//   - raw private key
//   - mnemonic
async function loadAccount(arg: string, plugin: Plugin): Promise<WrappedSigner> {

    // Secure entry; use prompt with mask
    if (arg === "-") {
        let content = await getPassword("Private Key / Mnemonic:");
        return loadAccount(content, plugin);
    }

    // Raw private key
    if (ethers.utils.isHexString(arg, 32)) {
         let signer = new ethers.Wallet(arg, plugin.provider)
         return Promise.resolve(new WrappedSigner(signer.getAddress(), () => Promise.resolve(signer), plugin));
    }

    // Mnemonic
    if (ethers.utils.isValidMnemonic(arg)) {
        let signer = ethers.Wallet.fromMnemonic(arg).connect(plugin.provider);
        return Promise.resolve(new WrappedSigner(signer.getAddress(), () => Promise.resolve(signer), plugin));
    }

    // Check for a JSON wallet
    try {
        let content = fs.readFileSync(arg).toString();
        let address = ethers.utils.getJsonWalletAddress(content);
        if (address) {
            return Promise.resolve(new WrappedSigner(
                Promise.resolve(address),
                async (): Promise<ethers.Signer> => {
                    let password = await getPassword(`Password (${arg}): `);

                    let progressBar = getProgressBar("Decrypting");
                    return ethers.Wallet.fromEncryptedJson(content, password, progressBar).then((wallet) => {
                        return wallet.connect(plugin.provider);
                    });
                },
                plugin));
        }
    } catch (error) {
        if (error.message === "cancelled") {
            throw new Error("Cancelled.");
        } else if (error.message === "wrong password") {
            throw new Error("Incorrect password.");
        }
    }

    throw new UsageError("unknown account option - [REDACTED]");
    return null;
}


/////////////////////////////
// Plugin Class

export interface Help {
    name: string;
    help: string;
}

export interface PluginType {
    new(...args: any[]): Plugin;
    getHelp?: () => Help;
    getOptionHelp?: () => Array<Help>;
}

export class Plugin {
    network: ethers.providers.Network;
    provider: ethers.providers.Provider;

    accounts: Array<WrappedSigner>;

    gasLimit: ethers.BigNumber;
    gasPrice: ethers.BigNumber;
    nonce: number;
    data: string;
    value: ethers.BigNumber;
    yes: boolean;

    constructor() {
    }

    static getHelp(): Help {
        return null;
    }

    static getOptionHelp(): Array<Help> {
        return [ ];
    }

    async prepareOptions(argParser: ArgParser): Promise<void> {
        let runners: Array<Promise<void>> = [ ];

        this.yes = argParser.consumeFlag("yes");

        /////////////////////
        // Provider

        let network = (argParser.consumeOption("network") || "homestead");
        let providers: Array<ethers.providers.BaseProvider> = [ ];

        let rpc: Array<ethers.providers.JsonRpcProvider> = [ ];
        argParser.consumeOptions("rpc").forEach((url) => {
            let provider = new ethers.providers.JsonRpcProvider(url)
            providers.push(provider);
            rpc.push(provider);
        });

        if (argParser.consumeFlag("alchemy")) {
            providers.push(new ethers.providers.AlchemyProvider(network));
        }

        if (argParser.consumeFlag("etherscan")) {
            providers.push(new ethers.providers.EtherscanProvider(network));
        }

        if (argParser.consumeFlag("infura")) {
            providers.push(new ethers.providers.InfuraProvider(network));
        }

        if (argParser.consumeFlag("nodesmith")) {
            providers.push(new ethers.providers.NodesmithProvider(network));
        }

        if (providers.length === 1) {
            this.provider = providers[0];
        } else if (providers.length) {
            this.provider = new ethers.providers.FallbackProvider(providers);
        } else {
            this.provider = ethers.getDefaultProvider(network);
        }


        /////////////////////
        // Accounts

        let accounts: Array<WrappedSigner> = [ ];

        let accountOptions = argParser.consumeMultiOptions([ "account", "account-rpc", "account-void" ]);
        for (let i = 0; i < accountOptions.length; i++) {
            let account = accountOptions[i];
            switch (account.name) {
                case "account":
                    let wrappedSigner = await loadAccount(account.value, this);
                    accounts.push(wrappedSigner);
                    break;

                case "account-rpc":
                    if (rpc.length !== 1) {
                        this.throwUsageError("--account-rpc requires exactly one JSON-RPC provider");
                    }

                    try {
                        let signer: ethers.providers.JsonRpcSigner = null;
                        if (account.value.match(/^[0-9]+$/)) {
                            signer = rpc[0].getSigner(parseInt(account.value));
                        } else {
                            signer = rpc[0].getSigner(ethers.utils.getAddress(account.value));
                        }
                        accounts.push(new WrappedSigner(signer.getAddress(), () => Promise.resolve(signer), this));
                    } catch (error) {
                        this.throwUsageError("invalid --account-rpc - " + account.value);
                    }
                    break;

                case "account-void": {
                    let addressPromise = this.provider.resolveName(account.value);
                    let signerPromise = addressPromise.then((addr) => {
                        return new ethers.VoidSigner(addr, this.provider);
                    });
                    accounts.push(new WrappedSigner(addressPromise, () => signerPromise, this));
                    break;
                }
            }
        }

        this.accounts = accounts;


        /////////////////////
        // Transaction Options

        let gasPrice = argParser.consumeOption("gas-price");
        if (gasPrice) {
            this.gasPrice = ethers.utils.parseUnits(gasPrice, "gwei");
        }

        let gasLimit = argParser.consumeOption("gas-limit");
        if (gasLimit) {
            this.gasLimit = ethers.BigNumber.from(gasLimit);
        }

        let nonce = argParser.consumeOption("nonce");
        if (nonce) {
            this.nonce = ethers.BigNumber.from(nonce).toNumber();
        }

        let value = argParser.consumeOption("value");
        if (value) {
            this.value = ethers.utils.parseEther(value);
        }

        let data = argParser.consumeOption("data");
        if (data) {
            this.data = ethers.utils.hexlify(data);
        }


        // Now wait for all asynchronous options to load

        runners.push(this.provider.getNetwork().then((network) => {
            this.network = network;
        }, (error) => {
            this.network = {
                chainId: 0,
                name: "no-network"
            }
        }));

        try {
            await Promise.all(runners)
        } catch (error) {
            this.throwError(error);
        }
    }

    prepareArgs(args: Array<string>): Promise<void> {
        return Promise.resolve(null);
    }

    run(): Promise<void> {
        return null;
    }

    getAddress(addressOrName: string, message?: string, allowZero?: boolean): Promise<string> {
        try {
            return Promise.resolve(ethers.utils.getAddress(addressOrName));
        } catch (error) { }

        return this.provider.resolveName(addressOrName).then((address) => {
            if (address == null) {
                this.throwError("ENS name not configured - " + addressOrName);
            }

            if (address === ethers.constants.AddressZero && !allowZero) {
                this.throwError(message);
            }

            return address;
        });
    }

    throwUsageError(message?: string): never {
        throw new UsageError(message);
    }

    throwError(message: string): never {
        throw new Error(message);
    }
}


/////////////////////////////
// Command Line Runner

export class CLI {
    readonly defaultCommand: string;
    //readonly plugins: { [ command: string ]: { new(...args: any[]): Plugin; getHelp(): Help; } };
    readonly plugins: { [ command: string ]: PluginType };

    constructor(defaultCommand: string) {
        ethers.utils.defineReadOnly(this, "defaultCommand", defaultCommand || null);
        ethers.utils.defineReadOnly(this, "plugins", { });
    }

    addPlugin(command: string, plugin: PluginType) {
        this.plugins[command] = plugin;
    }

    showUsage(message?: string, status?: number): never {
        // Limit:    |                                                                             |
        console.log("Usage:");

        let lines: Array<string> = [];
        for (let cmd in this.plugins) {
            let plugin = this.plugins[cmd];
            let help = (plugin.getHelp ? plugin.getHelp(): null);
            if (help == null) { continue; }
            let helpLine = "   " + help.name;
            if (helpLine.length > 28) {
                lines.push(helpLine);
                lines.push(repeat(" ", 30) + help.help);
            } else {
                helpLine += repeat(" ", 30 - helpLine.length);
                lines.push(helpLine + help.help);
            }

            let optionHelp = (plugin.getOptionHelp ? plugin.getOptionHelp(): [ ]);
            optionHelp.forEach((help) => {
                lines.push("      " + help.name + repeat(" ", 27 - help.name.length) + help.help);
            });
        }

        if (lines.length) {
            if (this.defaultCommand) {
                console.log("   ethers [ COMMAND ] [ ARGS ] [ OPTIONS ]");
                console.log("");
                console.log(`COMMANDS (default: ${this.defaultCommand})`);
            } else {
                console.log("   ethers COMMAND [ ARGS ] [ OPTIONS ]");
                console.log("");
                console.log("COMMANDS");
            }

            lines.forEach((line) => {
                console.log(line);
            });
            console.log("");
        }

        console.log("ACCOUNT OPTIONS");
        console.log("  --account FILENAME          Load a JSON Wallet (crowdsale or keystore)");
        console.log("  --account RAW_KEY           Use a private key (insecure *)");
        console.log("  --account 'MNEMONIC'        Use a mnemonic (insecure *)");
        console.log("  --account -                 Use secure entry for a raw key or mnemonic");
        console.log("  --account-void ADDRESS      Udd an address as a void signer");
        console.log("  --account-void ENS_NAME     Add the resolved address as a void signer");
        console.log("  --account-rpc ADDRESS       Add the address from a JSON-RPC provider");
        console.log("  --account-rpc INDEX         Add the index from a JSON-RPC provider");
        console.log("");
        console.log("PROVIDER OPTIONS (default: getDefaultProvider)");
        console.log("  --alchemy                   Include Alchemy");
        console.log("  --etherscan                 Include Etherscan");
        console.log("  --infura                    Include INFURA");
        console.log("  --nodesmith                 Include nodesmith");
        console.log("  --rpc URL                   Include a custom JSON-RPC");
        console.log("  --network NETWORK           Network to connect to (default: homestead)");
        console.log("");
        console.log("TRANSACTION OPTIONS (default: query the network)");
        console.log("  --gasPrice GWEI             Default gas price for transactions(in wei)");
        console.log("  --gasLimit GAS              Default gas limit for transactions");
        console.log("  --nonce NONCE               Initial nonce for the first transaction");
        console.log("  --value VALUE               Default value (in ether) for transactions");
        console.log("  --yes                       Always accept Siging and Sending");
        console.log("");
        console.log("OTHER OPTIONS");
        console.log("  --help                      Show this usage and quit");
        console.log("");
        console.log("(*) By including mnemonics or private keys on the command line they are");
        console.log("    possibly readable by other users on your system and may get stored in");
        console.log("    your bash history file.");
        console.log("");

        if (message) {
            console.log(message);
            console.log("");
        }

        process.exit(status || 0);
        throw new Error("never reached");
    }

    async run(args: Array<string>): Promise<void> {
        args = args.slice();

        let command: string = null;

        // We run a temporary argument parser to check for a command by processing standard options
        {
            let argParser = new ArgParser(args);

            [ "debug", "help", "yes"].forEach((key) => {
                argParser.consumeFlag(key);
            });

            [ "alchemy", "etherscan", "infura", "nodesmith" ].forEach((flag) => {
                argParser.consumeFlag(flag);
            });
            [ "network", "rpc", "account", "account-rpc", "account-void", "gas-price", "gas-limit", "nonce", "data" ].forEach((option) => {
                argParser.consumeOption(option);
            });

            let commandIndex = argParser._checkCommandIndex();
            if (commandIndex === -1) {
                command = this.defaultCommand;
            } else {
                command = args[commandIndex];
                args.splice(commandIndex, 1);
            }
        }

        // Reset the argument parser
        let argParser = new ArgParser(args);
        if (argParser.consumeFlag("help")) {
            return this.showUsage();
        }

        let debug = argParser.consumeFlag("debug");

        // Create PLug-in instance
        let plugin: Plugin = null;
        try {
            plugin = new this.plugins[command]();
        } catch (error) {
            if (command) { this.showUsage("unknown command - " + command); }
            return this.showUsage("no command provided", 1);
        }

        try {
            await plugin.prepareOptions(argParser);
            await plugin.prepareArgs(argParser._finalizeArgs());
            await plugin.run();

        } catch (error) {
            if (debug) {
                console.log("----- <DEBUG> ------")
                console.log(error);
                console.log("----- </DEBUG> -----")
            }
            if (error instanceof UsageError) {
                return this.showUsage(error.message, 1);
            }
            console.log("Error: " + error.message);
            process.exit(2);
        }
    }
}