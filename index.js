require('dotenv').config(); // Load variables from .env file
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch'); // Add at top
const axios = require('axios');
const bs58 = require('bs58');
const WebSocket = require('ws');

class WalletTracker {
  constructor() { // <-- No arguments needed here now!
      // --- Load Configuration ---
      const botToken = process.env.BOT_TOKEN;
      if (!botToken) {
          // It's critical, so stop if missing
          throw new Error("FATAL: BOT_TOKEN environment variable is missing!");
      }

      const webhookPort = parseInt(process.env.WEBHOOK_PORT) || 3000; // Default to 3000 if not set

      // API Keys (check if they exist, warn or throw error if critical ones are missing)
      this.heliusConfig = {
          apiKey: process.env.HELIUS_API_KEY,
          baseUrl: 'https://api.helius.xyz/v0',
          rpcUrl: process.env.HELIUS_RPC_URL // Ensure HELIUS_RPC_URL is in your .env
      };
      if (!this.heliusConfig.apiKey || !this.heliusConfig.rpcUrl) {
           console.warn("WARN: Helius API Key or RPC URL missing in environment variables. Some features might be limited.");
      }

      this.callStaticConfig = {
          apiKey: process.env.CALLSTATIC_API_KEY,
          baseUrl: 'https://api.callstaticrpc.com/pumpfun/v1'
      };
       if (!this.callStaticConfig.apiKey) {
           console.warn("WARN: CallStatic API Key missing. Token enrichment will be limited.");
       }

      this.solscanConfig = {
           apiKey: process.env.SOLSCAN_API_KEY, // Add checks if Solscan is used
           baseUrl: 'https://api.solscan.io',
           // Ensure headers/rateLimit objects are fully defined if needed, e.g.:
           headers: {
               'Accept': 'application/json',
               'User-Agent': 'WalletTracker/1.0'
               // Add other headers if necessary
           },
           rateLimit: {
               lastCall: 0,
               minInterval: 100 // 100ms between calls
           }
      };
      // Optional: Check if SOLSCAN_API_KEY is present if you rely on Solscan
      // if (!this.solscanConfig.apiKey) {
      //    console.warn("WARN: Solscan API Key missing. Solscan features might be limited.");
      // }


      // --- Unified RPC Endpoint Configuration ---
      this.rpcEndpoints = [
          process.env.ALCHEMY_RPC_URL, // Primary preferred
          this.heliusConfig.rpcUrl,    // Use Helius config for consistency
          process.env.ANKR_RPC_URL,     // Ankr as another option
          process.env.PUBLIC_RPC_URL    // Public as last resort
      ].filter(url => url); // Keep only defined URLs (removes undefined if env var is missing)

      // Check if the list is empty *after* filtering
      if (this.rpcEndpoints.length === 0) {
           // Throw the error *only if* the list is actually empty
           throw new Error("FATAL: No valid RPC endpoint URLs found in environment variables (Check ALCHEMY_RPC_URL, HELIUS_RPC_URL, ANKR_RPC_URL, PUBLIC_RPC_URL in .env).");
      }
      // If the check passes (list is not empty), proceed:
      this.currentRpcIndex = 0; // Use the unified index name
      console.log(`INFO: Configured ${this.rpcEndpoints.length} RPC endpoints.`);
      // --- End Unified RPC Configuration ---


      // --- Initialize Bot and Connection ---
      this.bot = new TelegramBot(botToken, { polling: true });
      // Initialize connection using the unified list and index
      this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], {
           commitment: 'confirmed',
      });
      console.log(`INFO: Initialized Solana connection with: ${this.rpcEndpoints[this.currentRpcIndex].split('?')[0]}`);


      // --- Webhook/Express Setup (Decide if needed) ---
      // If you primarily rely on polling, you might not need express/webhook.
      // If you DO need it, uncomment bodyParser require and use.
      this.app = express();
      this.port = webhookPort;
      // const bodyParser = require('body-parser'); // Require if using app.use below
      // this.app.use(bodyParser.json());


      // --- State Variables ---
      this.userSettings = new Map();
      this.recentTransactions = new Map();
      this.awaitingWallets = new Set();
      this.awaitingWalletCount = new Set();
      this.awaitingThreshold = new Set();
      this.monitoringIntervals = new Map();
      this.tokenCache = new Map();
      // Initialize rpcStats properly
      this.rpcStats = {
           lastRotation: Date.now(),
           rateLimitCount: 0,
           totalRequests: 0,
           totalRotations: 0 // Initialize totalRotations
       };


      // --- Default Settings ---
      this.defaultSettings = {
          solThreshold: 0.5,
          requiredWallets: 3,
          wallets: new Map(),
          isPaused: false,
          lastProcessedSignatures: new Map(),
          userWallets: [], // Initialize personal wallets array here
          monitoringStartTimes: {} // Initialize monitoring start times
      };


      // --- Initialize Bot Logic ---
      console.log("INFO: Initializing bot commands and handlers...");
      this.initialize(); // Call setup methods (which includes setupWebhook if needed)
  }
    initialize() {
        this.setupCommands();
        this.setupMessageHandler();
        this.setupWebhook();
        this.setupErrorHandling();
        console.log('Bot initialized successfully!');
    }

    rotateRpcProvider() {
        // Make sure to close any pending connections
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.rpcProviders.length;
        const newEndpoint = this.rpcProviders[this.currentProviderIndex];
        console.log(`Rotating to RPC provider #${this.currentProviderIndex}: ${newEndpoint.split('?')[0]}`);

        // Create a new connection with the new endpoint
        this.connection = new Connection(newEndpoint);
        return this.connection;
    }

    setupErrorHandling() {
        this.bot.on('polling_error', (error) => {
            console.error('Polling error:', error);
        });

        this.bot.on('error', (error) => {
            console.error('Bot error:', error);
        });

        process.on('unhandledRejection', (error) => {
            console.error('Unhandled promise rejection:', error);
        });
    }

    setupCommands() {
        // Basic commands with improved regex patterns
        this.bot.onText(/^\/start$/, (msg) => this.handleStart(msg));
        this.bot.onText(/^\/add$/, (msg) => this.handleAddWallets(msg));
        this.bot.onText(/^\/delete$/, (msg) => this.handleDeleteWallets(msg));
        this.bot.onText(/^\/show$/, (msg) => this.showWallets(msg));
        this.bot.onText(/^\/status$/, (msg) => this.checkWalletStatus(msg));
        this.bot.onText(/^\/menu$/, (msg) => this.showMenu(msg));
        this.bot.onText(/^\/createwallet$/, (msg) => this.handleCreateWallet(msg));
        this.bot.onText(/^\/balance$/, (msg) => this.handleCheckBalance(msg));
        this.bot.onText(/^\/mywallets$/, (msg) => this.showUserWallets(msg));
        this.bot.onText(/^\/deposit$/, (msg) => this.handleDeposit(msg));

        // Settings commands with comprehensive handling
        this.bot.onText(/^\/threshold$/, (msg) => {
            this.awaitingThreshold.add(msg.chat.id);
            this.bot.sendMessage(msg.chat.id, "Please provide a value in SOL (e.g., 1.5)");
        });

        this.bot.onText(/^\/threshold\s+(\d*\.?\d+)$/, (msg, match) => {
            this.setThreshold(msg, match[1]);
        });

        this.bot.onText(/^\/walletcount$/, (msg) => {
            this.awaitingWalletCount.add(msg.chat.id);
            this.bot.sendMessage(msg.chat.id, "Please provide a number (e.g., 3)");
        });

        this.bot.onText(/^\/walletcount\s+(\d+)$/, (msg, match) => {
            this.setWalletCount(msg, match[1]);
        });

        this.bot.onText(/^\/settings$/, (msg) => this.showSettings(msg));

        // Monitoring controls with confirmation
        this.bot.onText(/^\/pause$/, async (msg) => {
            await this.pauseMonitoring(msg);
        });

        this.bot.onText(/^\/resume$/, async (msg) => {
            await this.resumeMonitoring(msg);
        });
    }

    setupMessageHandler() {
        // Handle regular text messages
        this.bot.on('message', async (msg) => {
            try {
                // Handle wallet additions
                if (this.awaitingWallets.has(msg.chat.id) && !msg.text.startsWith('/')) {
                    await this.processWalletAddition(msg);
                }
                // Handle walletcount response
                else if (this.awaitingWalletCount.has(msg.chat.id) && !msg.text.startsWith('/')) {
                    const count = parseInt(msg.text);
                    if (!isNaN(count) && count > 0) {
                        await this.setWalletCount(msg, count);
                        this.awaitingWalletCount.delete(msg.chat.id);
                        await this.showSettings(msg); // Show updated settings after change
                    } else {
                        await this.bot.sendMessage(msg.chat.id,
                            "❌ Please provide a valid number greater than 0");
                    }
                }
                // Handle threshold response
                else if (this.awaitingThreshold.has(msg.chat.id) && !msg.text.startsWith('/')) {
                    const threshold = parseFloat(msg.text);
                    if (!isNaN(threshold) && threshold > 0) {
                        await this.setThreshold(msg, threshold);
                        this.awaitingThreshold.delete(msg.chat.id);
                        await this.showSettings(msg); // Show updated settings after change
                    } else {
                        await this.bot.sendMessage(msg.chat.id,
                            "❌ Please provide a valid number greater than 0");
                    }
                }
            } catch (error) {
                console.error('Error in message handler:', error);
                await this.bot.sendMessage(msg.chat.id,
                    "❌ An error occurred. Please try again.");
            }
        });

        // Handle callback queries from button clicks
        this.bot.on('callback_query', async (query) => {
            try {
                const [action, data] = query.data.split(':');

                if (action.startsWith('command_')) {
                    const command = action.replace('command_', '');
                    switch (command) {
                        // Existing commands
                        case 'add':
                            await this.handleAddWallets(query.message);
                            break;
                        case 'show':
                            await this.showWallets(query.message);
                            break;
                        case 'settings':
                            await this.showSettings(query.message);
                            break;
                        case 'delete':
                            await this.handleDeleteWallets(query.message);
                            break;
                        case 'pause':
                            await this.pauseMonitoring(query.message);
                            await this.showSettings(query.message); // Show updated status
                            break;
                        case 'resume':
                            await this.resumeMonitoring(query.message);
                            await this.showSettings(query.message); // Show updated status
                            break;
                        case 'status':
                            await this.checkWalletStatus(query.message);
                            break;
                        case 'threshold':
                            this.awaitingThreshold.add(query.message.chat.id);
                            await this.bot.sendMessage(query.message.chat.id,
                                "Please provide a value in SOL (e.g., 1.5)");
                            break;
                        case 'walletcount':
                            this.awaitingWalletCount.add(query.message.chat.id);
                            await this.bot.sendMessage(query.message.chat.id,
                                "Please provide a number (e.g., 3)");
                            break;

                        // New wallet commands
                        case 'create_wallet':
                            await this.handleCreateWallet(query.message);
                            break;
                        case 'my_wallets':
                            await this.showUserWallets(query.message);
                            break;
                    }
                } else {
                    // Handle specific actions with data
                    switch (action) {
                        case 'delete_wallet':
                            await this.deleteWallet(query.message.chat.id, data);
                            // Show updated wallet list after deletion
                            await this.showWallets(query.message);
                            break;
                        case 'check_balance':
                            await this.checkWalletBalance(query.message.chat.id, data);
                            break;
                        case 'deposit':
                            await this.showDepositInfo(query.message.chat.id, data);
                            break;
                        case 'send_sol':
                            // Start the sending SOL flow
                            this.awaitingSendAmount = this.awaitingSendAmount || new Map();
                            this.awaitingSendAmount.set(query.message.chat.id, {
                                fromWallet: data,
                                step: 'enter_destination'
                            });
                            await this.bot.sendMessage(query.message.chat.id,
                                "Please enter the destination wallet address:");
                            break;
                        case 'delete_user_wallet':
                            // Delete user's personal wallet (different from tracked wallets)
                            await this.deleteUserWallet(query.message.chat.id, data);
                            await this.showUserWallets(query.message);
                            break;
                    }
                }

                // Answer the callback query to remove loading state
                await this.bot.answerCallbackQuery(query.id);

            } catch (error) {
                console.error('Error in callback query:', error);
                await this.bot.answerCallbackQuery(query.id,
                    {text: "❌ An error occurred. Please try again."});
            }
        });
    }

    setupWebhook() {
        this.app.use(bodyParser.json());

        this.app.post('/webhook', async (req, res) => {
            try {
                const { signature, accountKeys } = req.body;
                await this.handleTransaction(signature, accountKeys);
                res.status(200).send('OK');
            } catch (error) {
                console.error('Webhook error:', error);
                res.status(500).send('Error processing webhook');
            }
        });

        this.app.listen(this.port, () => {
            console.log(`Webhook server running on port ${this.port}`);
        });
    }

    async handleStart(msg) {
        const welcome = `Welcome to the Solana Wallet Tracker! 🚀

    Use /menu to access all available commands and features.

    Quick Commands:
    /add - Add wallets to track
    /show - Show tracked wallets
    /settings - View current settings
    /menu - Show all options`;

        await this.bot.sendMessage(msg.chat.id, welcome);
    }

    async callCallStaticAPI(endpoint, params = {}) {
    try {
        const url = new URL(`${this.callStaticConfig.baseUrl}${endpoint}`);

        // Add query parameters
        Object.keys(params).forEach(key => {
            url.searchParams.append(key, params[key]);
        });

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.callStaticConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`CallStatic API error: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('CallStatic API error:', error);
        throw error;
    }
}

// Method to get token metadata from CallStatic
async getTokenMetadata(tokenAddress) {
    // Check cache first
    if (this.tokenCache.has(tokenAddress)) {
        const cachedData = this.tokenCache.get(tokenAddress);
        // Only use cache if it's less than 10 minutes old
        if (Date.now() - cachedData.timestamp < 10 * 60 * 1000) {
            return cachedData.data;
        }
    }

    try {
        const response = await this.callCallStaticAPI('/token/metadata', { token: tokenAddress });

        if (response && response.success && response.data) {
            // Extract relevant data
            const tokenData = {
                symbol: response.data.symbol || 'Unknown',
                name: response.data.name || 'Unknown',
                deployer: response.data.deployer,
                deployTime: new Date(response.data.deploy_timestamp).toISOString(),
                isComplete: response.data.is_complete,
                twitter: response.data.twitter,
                telegram: response.data.telegram,
                website: response.data.website
            };

            // Cache the result
            this.tokenCache.set(tokenAddress, {
                data: tokenData,
                timestamp: Date.now()
            });

            return tokenData;
        }
    } catch (error) {
        console.log(`Error fetching token metadata: ${error.message}`);
    }

    // Return basic info if we couldn't get metadata
    return {
        symbol: 'Unknown',
        name: 'Unknown'
    };
}


async getTokenMarketData(tokenAddress) {
    try {
        const response = await this.callCallStaticAPI('/token/marketData', { token: tokenAddress });

        if (response && response.success && response.data) {
            // Try to get holders count from additional endpoint
            let holdersCount = null;
            try {
                const holdersResponse = await this.callCallStaticAPI('/token/holders', { token: tokenAddress });
                if (holdersResponse?.success && holdersResponse?.data) {
                    holdersCount = holdersResponse.data.total_holders || null;
                }
            } catch (error) {
                console.log(`Error fetching holders data: ${error.message}`);
            }

            return {
                priceUsd: response.data.price_usd,
                priceSol: response.data.price_sol,
                marketCap: response.data.current_market_cap,
                bondingProgress: response.data.bonding_progress,
                holders: holdersCount
            };
        }
    } catch (error) {
        console.log(`Error fetching market data: ${error.message}`);
    }

    return {
        priceUsd: null,
        priceSol: null,
        marketCap: null,
        bondingProgress: null,
        holders: null
    };
}

// Method to get token volume data
async getTokenVolumeData(tokenAddress) {
    try {
        const response = await this.callCallStaticAPI('/token/volume', { token: tokenAddress });

        if (response && response.success && response.data) {
            // Calculate buy/sell ratio
            const buy24h = parseInt(response.data.buy_volume_24h || 0) / 1e9; // Convert lamports to SOL
            const sell24h = parseInt(response.data.sell_volume_24h || 0) / 1e9;
            const ratio = sell24h > 0 ? buy24h / sell24h : buy24h > 0 ? buy24h : 0;

            // Handle potentially invalid timestamps
            let lastBuyTime = "Unknown";
            let lastSellTime = "Unknown";

            try {
                if (response.data.last_buy_timestamp) {
                    lastBuyTime = new Date(response.data.last_buy_timestamp).toISOString();
                }
            } catch (e) {
                console.log("Invalid buy timestamp");
            }

            try {
                if (response.data.last_sell_timestamp) {
                    lastSellTime = new Date(response.data.last_sell_timestamp).toISOString();
                }
            } catch (e) {
                console.log("Invalid sell timestamp");
            }

            return {
                buyVolume1h: parseInt(response.data.buy_volume_1h || 0) / 1e9,
                buyVolume24h: buy24h,
                sellVolume24h: sell24h,
                buySellRatio: ratio.toFixed(2),
                lastBuyTime: lastBuyTime,
                lastSellTime: lastSellTime
            };
        }
    } catch (error) {
        console.log(`Error fetching volume data: ${error.message}`);
    }

    // Return default values on error
    return {
        buyVolume1h: 0,
        buyVolume24h: 0,
        sellVolume24h: 0,
        buySellRatio: "0.00",
        lastBuyTime: "Unknown",
        lastSellTime: "Unknown"
    };
}

    async handleAddWallets(msg) {
            const instructions = `Great! Send me the wallet addresses to track.

    Format: One address per line with optional nickname
    Example:
    wallet1 MyMainWallet
    wallet2 Trading
    wallet3

    Tip: It might take up to 2 min to start receiving notifications!`;

            this.awaitingWallets.add(msg.chat.id);
            await this.bot.sendMessage(msg.chat.id, instructions);
        }

        async processWalletAddition(msg) {
            try {
                const settings = this.getUserSettings(msg.chat.id);
                const lines = msg.text.split('\n');

                for (const line of lines) {
                    const [address, ...nicknameParts] = line.trim().split(' ');
                    const nickname = nicknameParts.join(' ') || `Wallet ${settings.wallets.size + 1}`;

                    try {
                        // Validate Solana address
                        const pubkey = new PublicKey(address);
                        settings.wallets.set(address, nickname);

                        // Start monitoring this wallet
                        await this.startMonitoringWallet(address, msg.chat.id);

                        await this.bot.sendMessage(msg.chat.id,
                            `✅ Added wallet: ${nickname}\nAddress: ${address.slice(0, 8)}...${address.slice(-8)}`);
                    } catch (error) {
                        await this.bot.sendMessage(msg.chat.id,
                            `❌ Invalid wallet address: ${address}`);
                    }
                }
            } catch (error) {
                console.error('Error processing wallet addition:', error);
                await this.bot.sendMessage(msg.chat.id,
                    "❌ Error adding wallets. Please try again.");
            } finally {
                this.awaitingWallets.delete(msg.chat.id);
            }
        }

        async callSolscanAPI(endpoint) {
        // Rate limiting
        const now = Date.now();
        const timeToWait = Math.max(0, this.solscanConfig.rateLimit.minInterval -
            (now - this.solscanConfig.rateLimit.lastCall));

        if (timeToWait > 0) {
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }

        try {
            const response = await fetch(`${this.solscanConfig.baseUrl}${endpoint}`, {
                headers: {
                    ...this.solscanConfig.headers,
                    'token': this.solscanConfig.apiKey
                }
            });

            this.solscanConfig.rateLimit.lastCall = Date.now();

            if (!response.ok) {
                throw new Error(`Solscan API error: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Solscan API error:', error);
            throw error;
        }
    }

        async checkWalletStatus(msg) {
    try {
        const settings = this.getUserSettings(msg.chat.id);

        if (settings.wallets.size === 0) {
            await this.bot.sendMessage(msg.chat.id, "No wallets are being tracked. Use /add to add wallets.");
            return;
        }

        let message = "📊 Monitoring Status:\n\n";
        for (const [address, nickname] of settings.wallets) {
            const isMonitoring = this.monitoringIntervals.has(`${msg.chat.id}:${address}`);
            const status = isMonitoring ? "✅ Active" : "❌ Inactive";
            message += `${nickname}\n${address.slice(0, 8)}...${address.slice(-8)}\n${status}\n\n`;
        }

        message += `\nSettings:\n`;
        message += `Minimum SOL: ${settings.solThreshold} SOL\n`;
        message += `Required Wallets: ${settings.requiredWallets}\n`;
        message += `Monitoring Status: ${settings.isPaused ? '⏸️ Paused' : '▶️ Active'}`;

        await this.bot.sendMessage(msg.chat.id, message);
    } catch (error) {
        console.error('Error checking status:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error checking status. Please try again.");
    }
}

async pauseMonitoring(msg) {
    try {
        const settings = this.getUserSettings(msg.chat.id);
        settings.isPaused = true;

        // No need to close WebSockets since we're not using them anymore

        await this.bot.sendMessage(msg.chat.id, "⏸️ Monitoring paused");
    } catch (error) {
        console.error('Error pausing monitoring:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error pausing monitoring");
    }
}

async showMenu(msg) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: '✨ Add Tracker Wallets', callback_data: 'command_add', width: '50%' },
                { text: '📊 Show Tracked Wallets', callback_data: 'command_show', width: '50%' }
            ],
            [
                { text: '⚙️ Settings', callback_data: 'command_settings', width: '50%' },
                { text: '📈 Check Status', callback_data: 'command_status', width: '50%' }
            ],
            [
                { text: '🔑 Create Personal Wallet', callback_data: 'command_create_wallet', width: '50%' },
                { text: '💰 My Wallets', callback_data: 'command_my_wallets', width: '50%' }
            ],
            [
                { text: '⏸️ Pause Monitoring', callback_data: 'command_pause', width: '50%' },
                { text: '▶️ Resume Monitoring', callback_data: 'command_resume', width: '50%' }
            ]
        ]
    };

    await this.bot.sendMessage(msg.chat.id, '🔍 Select an action:', {
        reply_markup: keyboard
    });
}

// REPLACE your existing rotateRpcEndpoint method with this one:
rotateRpcEndpoint() {
    // Increment index and wrap around using modulo
    // NOTE: We assume the constructor will be updated to use this.rpcEndpoints and this.currentRpcIndex
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcEndpoints.length;
    const newEndpoint = this.rpcEndpoints[this.currentRpcIndex]; // Get the NEW endpoint URL

    console.log(`INFO: Rotating RPC endpoint to #${this.currentRpcIndex}: ${newEndpoint.split('?')[0]}`);

    try {
        // Create a new connection object with the new endpoint
        this.connection = new Connection(newEndpoint, {
            commitment: 'confirmed', // Maintain consistency
        });

        // Reset rate limit count tracking *after* successful rotation and connection creation
        this.rpcStats.rateLimitCount = 0;
        this.rpcStats.lastRotation = Date.now();
        this.rpcStats.totalRotations = (this.rpcStats.totalRotations || 0) + 1;

        console.log(`INFO: Successfully rotated connection to ${newEndpoint.split('?')[0]}`);
        return this.connection;

    } catch (error) {
        console.error(`ERROR: Failed to create new connection during RPC rotation to ${newEndpoint}:`, error);
        // Return old connection for now as a fallback
        return this.connection;
    }
}

async callWithBackoff(apiFunction, maxRetries = 3) {
    let retries = 0;

    while (retries <= maxRetries) {
        try {
            this.rpcStats.totalRequests++;
            return await apiFunction();
        } catch (error) {
            const isRateLimit = error.toString().includes('429') ||
                               error.toString().includes('rate limit') ||
                               error.message?.includes('429');

            if (isRateLimit && retries < maxRetries) {
                this.rpcStats.rateLimitCount++;
                const delay = Math.min(1000 * Math.pow(2, retries), 10000); // Max 10 seconds
                console.log(`Rate limited. Retrying in ${delay}ms (attempt ${retries + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;

                // Rotate endpoint if we keep getting rate limited
                if (this.rpcStats.rateLimitCount >= 3) {
                    this.rotateRpcEndpoint();
                }
            } else {
                throw error; // Rethrow if not rate limit or max retries exceeded
            }
        }
    }
}

async resumeMonitoring(msg) {
    try {
        const settings = this.getUserSettings(msg.chat.id);

        if (!settings.isPaused) {
            await this.bot.sendMessage(msg.chat.id, "▶️ Monitoring is already active");
            return;
        }

        settings.isPaused = false;

        // Restart monitoring for all wallets
        for (const [address] of settings.wallets) {
            await this.startMonitoringWallet(address, msg.chat.id);
        }

        await this.bot.sendMessage(msg.chat.id, "▶️ Monitoring resumed");
    } catch (error) {
        console.error('Error resuming monitoring:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error resuming monitoring");
    }
}

        async handleDeleteWallets(msg) {
            const settings = this.getUserSettings(msg.chat.id);

            if (settings.wallets.size === 0) {
                await this.bot.sendMessage(msg.chat.id, "No wallets to delete!");
                return;
            }

            const keyboard = {
                inline_keyboard: Array.from(settings.wallets.entries()).map(([address, nickname]) => [{
                    text: `${nickname} (${address.slice(0, 8)}...)`,
                    callback_data: `delete_wallet:${address}`
                }])
            };

            await this.bot.sendMessage(msg.chat.id, "Select wallet to delete:", {
                reply_markup: keyboard
            });
        }

        async deleteWallet(chatId, address) {
            try {
                const settings = this.getUserSettings(chatId);
                const nickname = settings.wallets.get(address);

                // Stop monitoring this wallet
                if (this.monitoringIntervals.has(`${chatId}:${address}`)) {
                    clearInterval(this.monitoringIntervals.get(`${chatId}:${address}`));
                    this.monitoringIntervals.delete(`${chatId}:${address}`);
                }

                settings.wallets.delete(address);
                settings.lastProcessedSignatures.delete(address);

                await this.bot.sendMessage(chatId,
                    `✅ Deleted wallet: ${nickname}\nAddress: ${address.slice(0, 8)}...${address.slice(-8)}`);
            } catch (error) {
                console.error('Error deleting wallet:', error);
                await this.bot.sendMessage(chatId, "❌ Error deleting wallet. Please try again.");
            }
        }

        async showWallets(msg) {
    try {
        const settings = this.getUserSettings(msg.chat.id);

        if (settings.wallets.size === 0) {
            await this.bot.sendMessage(msg.chat.id, "No wallets being tracked. Use /add to add wallets.");
            return;
        }

        let message = "📝 Tracked Wallets:\n\n";
        for (const [address, nickname] of settings.wallets) {
            message += `${nickname}\n${address.slice(0, 8)}...${address.slice(-8)}\n\n`;
        }

        await this.bot.sendMessage(msg.chat.id, message);
    } catch (error) {
        console.error('Error showing wallets:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error displaying wallets. Please try again.");
    }
}

async showSettings(msg) {
    try {
        const settings = this.getUserSettings(msg.chat.id);

        const message = `⚙️ Current Settings:

🎯 Minimum SOL: ${settings.solThreshold} SOL
👥 Required Wallets: ${settings.requiredWallets}
📊 Tracked Wallets: ${settings.wallets.size}
📡 Status: ${settings.isPaused ? '⏸️ Paused' : '▶️ Active'}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💰 Set Threshold', callback_data: 'command_threshold', width: '50%' },
                    { text: '👥 Set Wallets', callback_data: 'command_walletcount', width: '50%' }
                ],
                [
                    { text: settings.isPaused ? '▶️ Resume Monitoring' : '⏸️ Pause Monitoring',
                      callback_data: settings.isPaused ? 'command_resume' : 'command_pause',
                      width: '100%' }
                ]
            ]
        };

        await this.bot.sendMessage(msg.chat.id, message, {
            reply_markup: keyboard
        });
    } catch (error) {
        console.error('Error showing settings:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error displaying settings. Please try again.");
    }
}


        async setThreshold(msg, threshold) {
            try {
                const settings = this.getUserSettings(msg.chat.id);
                const newThreshold = parseFloat(threshold);

                if (isNaN(newThreshold) || newThreshold <= 0) {
                    await this.bot.sendMessage(msg.chat.id,
                        "❌ Please provide a valid threshold greater than 0");
                    return;
                }

                settings.solThreshold = newThreshold;
                await this.bot.sendMessage(msg.chat.id,
                    `✅ Threshold updated to ${newThreshold} SOL`);
            } catch (error) {
                console.error('Error setting threshold:', error);
                await this.bot.sendMessage(msg.chat.id,
                    "❌ Error updating threshold. Please try again.");
            }
        }

        async setWalletCount(msg, count) {
            try {
                const settings = this.getUserSettings(msg.chat.id);
                const newCount = parseInt(count);

                if (isNaN(newCount) || newCount <= 0) {
                    await this.bot.sendMessage(msg.chat.id,
                        "❌ Please provide a valid number greater than 0");
                    return;
                }

                settings.requiredWallets = newCount;
                await this.bot.sendMessage(msg.chat.id,
                    `✅ Required wallets updated to ${newCount}`);
            } catch (error) {
                console.error('Error setting wallet count:', error);
                await this.bot.sendMessage(msg.chat.id,
                    "❌ Error updating wallet count. Please try again.");
            }
        }

        async startMonitoringWallet(address, chatId) {
            try {
                // Clear any existing monitoring
                if (this.monitoringIntervals.has(`${chatId}:${address}`)) {
                    clearInterval(this.monitoringIntervals.get(`${chatId}:${address}`));
                    this.monitoringIntervals.delete(`${chatId}:${address}`);
                }

                const settings = this.getUserSettings(chatId);
                const nickname = settings.wallets.get(address);

                // Send initial confirmation
                await this.bot.sendMessage(chatId,
                    `🔄 Starting monitoring for ${nickname} (${address.slice(0, 8)}...)`);

                // Record monitoring start time
                const monitoringStartTime = Math.floor(Date.now() / 1000);
                console.log(`Started monitoring ${nickname} at ${new Date(monitoringStartTime * 1000).toISOString()}`);

                // Store monitoring state
                settings.monitoringStartTimes = settings.monitoringStartTimes || {};
                settings.monitoringStartTimes[address] = monitoringStartTime;

                // Get the first signature to start monitoring from
                const pubkey = new PublicKey(address);
                try {
                    const initialSigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 1 });
                    if (initialSigs.length > 0) {
                        settings.lastProcessedSignatures = settings.lastProcessedSignatures || new Map();
                        settings.lastProcessedSignatures.set(address, initialSigs[0].signature);
                        console.log(`Set initial signature for ${nickname}: ${initialSigs[0].signature.slice(0, 8)}...`);
                    }
                } catch (error) {
                    console.error(`Error getting initial signatures for ${address}:`, error);
                }

                // Use a simple polling approach
                const interval = setInterval(async () => {
                    if (settings.isPaused) return;

                    try {
                        // Only check for new transactions using a small limit
                        const newSigs = await this.connection.getSignaturesForAddress(pubkey, {
                            limit: 2, // Check the 2 most recent
                        });
                        if (newSigs.length === 0) return;

                        const lastProcessedSig = settings.lastProcessedSignatures.get(address);

                        // Find signatures we haven't processed yet
                        const newSignatures = [];
                        for (const sig of newSigs) {
                            if (sig.signature === lastProcessedSig) break;
                            newSignatures.push(sig);
                        }
                        if (newSignatures.length === 0) return;

                        console.log(`Found ${newSignatures.length} new transaction(s) for ${nickname}`);

                        // Update the last processed signature
                        settings.lastProcessedSignatures.set(address, newSignatures[0].signature);

                        // Process transactions (newest -> oldest) with a small delay
                        for (let i = newSignatures.length - 1; i >= 0; i--) {
                            const sig = newSignatures[i];

                            // Skip if transaction is too old
                            if (sig.blockTime && sig.blockTime < monitoringStartTime) {
                                console.log(`Skipping old transaction from ${new Date(sig.blockTime * 1000).toISOString()}`);
                                continue;
                            }

                            // Get transaction details
                            try {
                                const tx = await this.connection.getTransaction(sig.signature, {
                                    maxSupportedTransactionVersion: 0
                                });

                                if (!tx) {
                                    console.log(`Transaction ${sig.signature.slice(0, 8)}... not found`);
                                    continue;
                                }

                                // Always try extracting token info
                                const tokenInfo = await this.extractTokenInfoFromTx(tx, chatId, address);

                                // If we found a valid token that the user gained, treat it as a buy/swap
                                if (
                                    tokenInfo &&
                                    tokenInfo.tokenAddress !== 'unknown' &&
                                    tokenInfo.tokenAmount > 0
                                ) {
                                    console.log(`Processing swap transaction: ${sig.signature.slice(0, 8)}...`);
                                    await this.processTransaction(sig.signature, chatId, address, tx, tokenInfo);
                                } else {
                                    console.log(`Skipping non-token transaction: ${sig.signature.slice(0, 8)}...`);
                                }
                            } catch (txError) {
                                console.error(`Error processing transaction ${sig.signature}:`, txError);
                            }

                            // Delay to avoid rate limits
                            await new Promise(r => setTimeout(r, 500));
                        }
                    } catch (error) {
                        console.error(`Error monitoring wallet ${address}:`, error);
                    }
                }, 30000); // Poll every 30 seconds

                this.monitoringIntervals.set(`${chatId}:${address}`, interval);

                // Confirm monitoring is active
                await this.bot.sendMessage(chatId,
                    `✅ Now monitoring ${nickname} (${address.slice(0, 8)}...) for new token transactions`);
            } catch (error) {
                console.error('Error starting wallet monitoring:', error);
                await this.bot.sendMessage(chatId,
                    `❌ Error starting monitoring for ${address.slice(0, 8)}...`);
            }
        }


        async processTransaction(signature, chatId, walletAddress, tx, tokenInfo = null) {
            try {
                console.log(`Processing transaction: ${signature.slice(0, 8)}... for wallet ${walletAddress.slice(0, 8)}...`);

                // If tokenInfo wasn't passed in, try to extract it from the transaction
                if (!tokenInfo) {
                    tokenInfo = await this.extractTokenInfoFromTx(tx, chatId, walletAddress);
                    if (!tokenInfo) {
                        console.log(`No token purchase detected in transaction ${signature.slice(0, 8)}...`);
                        return;
                    }
                }

                const { tokenAddress, tokenName, solAmount, tokenAmount } = tokenInfo;
                console.log(
                    `Detected token purchase: ${tokenName} (${tokenAddress.slice(0, 8)}...) ` +
                    `for ${solAmount.toFixed(4)} SOL (${tokenAmount} tokens)`
                );

                const settings = this.getUserSettings(chatId);

                // Build a key for recent transactions
                const key = `${chatId}:${tokenAddress}`;
                if (!this.recentTransactions.has(key)) {
                    this.recentTransactions.set(key, {
                        buyers: new Map(),
                        timestamp: Date.now(),
                        firstSeen: Date.now()
                    });
                    console.log(`First detection of token ${tokenName} (${tokenAddress.slice(0, 8)}...)`);
                }

                const txData = this.recentTransactions.get(key);

                // Update buyer's SOL spent on this token
                const previousAmount = txData.buyers.get(walletAddress) || 0;
                txData.buyers.set(walletAddress, previousAmount + solAmount);

                console.log(
                    `Wallet ${walletAddress.slice(0, 8)}... total spent on ${tokenName}: ` +
                    `${(previousAmount + solAmount).toFixed(4)} SOL`
                );

                // Calculate total SOL spent
                const totalSolSpentOnToken = Array.from(txData.buyers.values()).reduce((sum, amount) => sum + amount, 0);

                // Log tracking status
                console.log(
                    `Token ${tokenName} tracking status:\n` +
                    `- Unique wallets: ${txData.buyers.size}/${settings.requiredWallets}\n` +
                    `- Total SOL spent: ${totalSolSpentOnToken.toFixed(4)}/${settings.solThreshold} SOL\n` +
                    `- Time tracking: ${Math.floor((Date.now() - txData.firstSeen) / 1000)} seconds`
                );

                // Check alert conditions
                if (
                    txData.buyers.size >= settings.requiredWallets &&
                    totalSolSpentOnToken >= settings.solThreshold
                ) {
                    console.log(`🚨 Alert threshold reached for ${tokenName}!`);
                    // Send the alert
                    await this.sendAlert(
    chatId,
    tokenAddress,
    tokenName,
    txData.buyers,          // Pass the entire Map
    totalSolSpentOnToken
);
                    // Remove tracking once alert is sent
                    this.recentTransactions.delete(key);
                    console.log(`Removed ${tokenName} from tracking after alert sent`);
                }

                // Cleanup old entries (e.g., older than 1 hour)
                const now = Date.now();
                for (const [existingKey, data] of this.recentTransactions.entries()) {
                    if (now - data.timestamp > 3600000) { // 1 hour
                        console.log(
                            `Removing expired tracking for token ` +
                            `${existingKey.split(':')[1].slice(0, 8)}...`
                        );
                        this.recentTransactions.delete(existingKey);
                    }
                }

            } catch (error) {
                console.error(`Error processing transaction ${signature.slice(0, 8)}...`, error);
            }
        }


        // Update extractTokenInfoFromTx to use our new methods
        async extractTokenInfoFromTx(tx, chatId, walletAddress) {
            try {
                if (!tx || !tx.meta) {
                    return null;
                }

                // Get user’s current settings (including their solThreshold).
                const settings = this.getUserSettings(chatId);

                // 1) Calculate net SOL spent
                let solAmount = 0;
                if (tx.meta.preBalances && tx.meta.postBalances) {
                    const preSOL = tx.meta.preBalances[0] / 1e9;
                    const postSOL = tx.meta.postBalances[0] / 1e9;
                    solAmount = Math.max(0, preSOL - postSOL);
                }

                // 2) Respect the user’s threshold. If SOL outflow is less than their threshold, skip.
                if (solAmount < settings.solThreshold) {
                    console.log(
                        `Spent ${solAmount} SOL which is below the user’s threshold of ${settings.solThreshold} SOL. Skipping.`
                    );
                    return null;
                }

                // 3) Build a map of user’s pre-transaction token balances
                const preBalanceMap = new Map();
                if (tx.meta.preTokenBalances) {
                    for (const bal of tx.meta.preTokenBalances) {
                        if (bal.owner === walletAddress) {
                            const mint = bal.mint;
                            const preAmount = bal.uiTokenAmount?.uiAmount || 0;
                            preBalanceMap.set(mint, preAmount);
                        }
                    }
                }

                // 4) Find which mint had the largest net increase in the user’s wallet
                let tokenAddress = null;
                let tokenAmount = 0;

                if (tx.meta.postTokenBalances) {
                    for (const bal of tx.meta.postTokenBalances) {
                        if (bal.owner === walletAddress) {
                            const mint = bal.mint;
                            const preAmount = preBalanceMap.get(mint) || 0;
                            const postAmount = bal.uiTokenAmount?.uiAmount || 0;
                            const diff = postAmount - preAmount;

                            if (diff > tokenAmount) {
                                tokenAmount = diff;
                                tokenAddress = mint;
                            }
                        }
                    }
                }

                // 5) If no net gain, mark as unknown
                if (!tokenAddress) {
                    console.log(`No net token gain found for wallet ${walletAddress}. Using "unknown".`);
                    tokenAddress = 'unknown';
                }

                // 6) Build result
                let result = {
                    tokenAddress,
                    tokenName: 'Unknown',
                    tokenAmount,
                    solAmount
                };

                // 7) If we have a valid mint, fetch metadata
                if (tokenAddress !== 'unknown') {
                    try {
                        const tokenMetadata = await this.getTokenMetadata(tokenAddress);
                        const marketData = await this.getTokenMarketData(tokenAddress);
                        const volumeData = await this.getTokenVolumeData(tokenAddress);

                        result.tokenName = tokenMetadata.symbol || 'Unknown';
                        result.tokenFullName = tokenMetadata.name || 'Unknown';
                        result.metadata = tokenMetadata;
                        result.marketData = marketData;
                        result.volumeData = volumeData;
                    } catch (err) {
                        console.log(`Error fetching data for ${tokenAddress}: ${err.message}`);
                    }
                }

                console.log(
                    `Extracted token info: ${result.tokenName} (${result.tokenAddress.slice(0, 8)}...) ` +
                    `for ${result.solAmount.toFixed(4)} SOL (${result.tokenAmount} tokens)`
                );
                return result;

            } catch (error) {
                console.error('Error extracting token info:', error);
                return null;
            }
        }



        async extractTokenInfo(transaction) {
            try {
                if (!transaction?.meta?.preBalances || !transaction?.meta?.postBalances || !transaction?.transaction) {
                    return null;
                }

                // 1. Verify this is an actual token purchase (SOL outflow)
                const preSOL = transaction.meta.preBalances[0] / 1e9;
                const postSOL = transaction.meta.postBalances[0] / 1e9;
                const solSpent = Math.max(0, preSOL - postSOL);

                // Ignore dust or fee-only transactions
                if (solSpent < 0.01) {
                    return null;
                }

                // 2. Verify this is a RECENT transaction (within last 30 minutes)
                const blockTime = transaction.blockTime || 0;
                const currentTime = Math.floor(Date.now() / 1000);
                const maxAge = 30 * 60; // 30 minutes

                if (blockTime > 0 && (currentTime - blockTime) > maxAge) {
                    console.log(`Skipping old transaction from ${new Date(blockTime * 1000).toISOString()}`);
                    return null;
                }

                // 3. Check for token program involvement (required for token purchases)
                const tokenProgramId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
                let tokenProgramInvolved = false;

                if (transaction.transaction.message?.accountKeys) {
                    const accountKeys = transaction.transaction.message.accountKeys;

                    if (Array.isArray(accountKeys)) {
                        // Handle different formats of accountKeys
                        if (typeof accountKeys[0] === 'object' && accountKeys[0]?.pubkey) {
                            // Format: [{pubkey: PublicKey, ...}, ...]
                            tokenProgramInvolved = accountKeys.some(key =>
                                key.pubkey && key.pubkey.toString() === tokenProgramId);
                        } else if (typeof accountKeys[0] === 'string') {
                            // Format: [string, string, ...]
                            tokenProgramInvolved = accountKeys.includes(tokenProgramId);
                        }
                    }

                    if (!tokenProgramInvolved) {
                        return null; // Not a token transaction
                    }
                } else {
                    return null; // Can't verify token program involvement
                }

                // 4. Look for token balance changes (most reliable indicator)
                if (!transaction.meta.postTokenBalances || transaction.meta.postTokenBalances.length === 0) {
                    return null; // No token balances changed
                }

                // Find tokens that had balance increases (token purchases)
                const preTokens = new Map();
                if (transaction.meta.preTokenBalances) {
                    transaction.meta.preTokenBalances.forEach(bal => {
                        if (bal.mint) {
                            const amount = bal.uiTokenAmount?.uiAmount || 0;
                            preTokens.set(bal.mint, amount);
                        }
                    });
                }

                let boughtToken = null;
                let tokenAmount = 0;

                for (const postBal of transaction.meta.postTokenBalances) {
                    if (!postBal.mint) continue;

                    const preBal = preTokens.get(postBal.mint) || 0;
                    const postAmount = postBal.uiTokenAmount?.uiAmount || 0;

                    // Token balance increased - this is a purchase
                    if (postAmount > preBal) {
                        boughtToken = postBal.mint;
                        tokenAmount = postAmount - preBal;
                        break;
                    }
                }

                if (!boughtToken) {
                    return null; // No token purchase detected
                }

                // 5. Get token info from local cache or Helius instead of Solscan
                // Create a token cache if it doesn't exist
                if (!this.tokenCache) this.tokenCache = new Map();

                let tokenName = 'Unknown';
                let marketCap = null;
                let holders = null;

                // Try to get from cache first
                if (this.tokenCache.has(boughtToken)) {
                    const cachedInfo = this.tokenCache.get(boughtToken);
                    tokenName = cachedInfo.tokenName;
                    marketCap = cachedInfo.marketCap;
                    holders = cachedInfo.holders;
                } else {
                    // Try Helius instead of Solscan
                    try {
                        const heliusResponse = await axios.get(
                            `${this.heliusConfig.baseUrl}/addresses/${boughtToken}/balances`,
                            {
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${this.heliusConfig.apiKey}`
                                }
                            }
                        );

                        if (heliusResponse.data && heliusResponse.data.tokens && heliusResponse.data.tokens.length > 0) {
                            const tokenData = heliusResponse.data.tokens[0];
                            tokenName = tokenData.symbol || 'Unknown';

                            // Cache the result
                            this.tokenCache.set(boughtToken, {
                                tokenName,
                                marketCap,
                                holders,
                                lastUpdated: Date.now()
                            });
                        }
                    } catch (error) {
                        console.log(`Could not fetch token info for ${boughtToken}: ${error.message}`);
                        // Cache the result anyway to avoid repeated lookups
                        this.tokenCache.set(boughtToken, {
                            tokenName: 'Unknown',
                            marketCap: null,
                            holders: null,
                            lastUpdated: Date.now()
                        });
                    }
                }

                // 6. Verify transaction result with a sanity check
                console.log(`Detected potential purchase: ${solSpent.toFixed(4)} SOL spent, received ${tokenAmount} ${tokenName} (${boughtToken.slice(0,8)}...)`);

                return {
                    tokenAddress: boughtToken,
                    tokenName,
                    solAmount: solSpent,
                    tokenAmount,
                    marketCap,
                    holders
                };
            } catch (error) {
                console.error('Error extracting token info:', error);
                return null;
            }
        }

                // If we got here, we couldn't identify a specific to
        // Helper to fetch and format token details
        async getTokenDetails(tokenAddress, solAmount) {
            let tokenName = 'Unknown';
            let marketCap = null;
            let holders = null;

            try {
                const tokenInfo = await this.callSolscanAPI(`/token/${tokenAddress}`);
                tokenName = tokenInfo?.symbol || 'Unknown';
                marketCap = tokenInfo?.marketCapacity;
                holders = tokenInfo?.holder;
            } catch (error) {
                console.error('Error fetching token info:', error);
            }

            return {
                tokenAddress,
                tokenName,
                solAmount,
                marketCap,
                holders
            };
        }

          async handleCreateWallet(msg) {
              try {
                  // Generate new Solana wallet using local keypair
                  const wallet = Keypair.generate();
                  const publicKey = wallet.publicKey.toString();

                  // Convert secretKey to a more storable format instead of using bs58
                  const privateKey = Buffer.from(wallet.secretKey).toString('hex');

                  // Get user settings
                  const userSettings = this.getUserSettings(msg.chat.id);

                  // Initialize user wallets if not exists
                  if (!userSettings.userWallets) {
                      userSettings.userWallets = [];
                  }

                  // Add new wallet to user's wallets
                  const walletName = `Wallet ${userSettings.userWallets.length + 1}`;
                  userSettings.userWallets.push({
                      address: publicKey,
                      privateKey: privateKey, // Stored as hex string
                      label: walletName,
                      created: Date.now()
                  });

                  // Send wallet info to user
                  await this.bot.sendMessage(msg.chat.id,
                      `✅ Created new Solana wallet!\n\nName: ${walletName}\nAddress: \`${publicKey}\``,
                      { parse_mode: 'Markdown' });

                  // Send private key as separate message with warning
                  await this.bot.sendMessage(msg.chat.id,
                      `🔐 *IMPORTANT: This is your private key for ${walletName}*\n\n\`${privateKey}\`\n\n⚠️ *WARNING: NEVER share this with anyone! Save it securely offline. It cannot be recovered if lost.*`,
                      { parse_mode: 'Markdown' });

                  // Show deposit button
                  const keyboard = {
                      inline_keyboard: [
                          [{ text: '📥 Deposit SOL to this wallet', callback_data: `deposit:${publicKey}` }],
                          [{ text: '💰 Check Balance', callback_data: `check_balance:${publicKey}` }]
                      ]
                  };

                  await this.bot.sendMessage(msg.chat.id,
                      `What would you like to do with ${walletName}?`,
                      { reply_markup: keyboard });

              } catch (error) {
                  console.error('Error creating wallet:', error);
                  await this.bot.sendMessage(msg.chat.id, "❌ Error creating wallet. Please try again.");
              }
          }

async handleCheckBalance(msg) {
    try {
        const userSettings = this.getUserSettings(msg.chat.id);

        if (!userSettings.userWallets || userSettings.userWallets.length === 0) {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔑 Create Wallet', callback_data: 'command_create_wallet' }]
                ]
            };

            await this.bot.sendMessage(msg.chat.id,
                "You don't have any wallets yet. Would you like to create one?",
                { reply_markup: keyboard });
            return;
        }

        const keyboard = {
            inline_keyboard: userSettings.userWallets.map(wallet => [{
                text: `${wallet.label} (${wallet.address.slice(0, 8)}...)`,
                callback_data: `check_balance:${wallet.address}`
            }])
        };

        await this.bot.sendMessage(msg.chat.id, "Select a wallet to check balance:", {
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error handling balance check:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error checking balance. Please try again.");
    }
}

async checkWalletBalance(chatId, walletAddress) {
    try {
        // Use Helius RPC to get balance
        const response = await axios.post(this.heliusConfig.rpcUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [walletAddress]
        });

        if (response.data && response.data.result) {
            const balanceInLamports = response.data.result.value;
            const balanceInSol = balanceInLamports / 1000000000; // Convert lamports to SOL

            const userSettings = this.getUserSettings(chatId);
            const wallet = userSettings.userWallets.find(w => w.address === walletAddress);
            const walletName = wallet ? wallet.label : 'Wallet';

            // Get token balances using Helius enhanced API
            let tokenMessage = '';
            try {
                const balancesResponse = await axios.get(
                    `${this.heliusConfig.baseUrl}/addresses/${walletAddress}/balances`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.heliusConfig.apiKey}`
                    }
                });

                if (balancesResponse.data && balancesResponse.data.tokens && balancesResponse.data.tokens.length > 0) {
                    tokenMessage = '\n\n📊 Token Balances:';
                    const tokens = balancesResponse.data.tokens.slice(0, 5); // Limit to top 5 tokens

                    for (const token of tokens) {
                        const tokenAmount = token.amount / Math.pow(10, token.decimals);
                        tokenMessage += `\n${token.symbol || 'Unknown'}: ${tokenAmount.toFixed(4)}`;
                    }

                    if (balancesResponse.data.tokens.length > 5) {
                        tokenMessage += `\n...and ${balancesResponse.data.tokens.length - 5} more tokens`;
                    }
                }
            } catch (err) {
                console.error('Error fetching token balances:', err);
            }

            // Create response with balance info
            const message = `💰 Balance for ${walletName}:\n\n` +
                `SOL: ${balanceInSol.toFixed(6)} SOL` +
                `${tokenMessage}`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '📥 Deposit', callback_data: `deposit:${walletAddress}` }]
                ]
            };

            await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } else {
            throw new Error('Invalid response from Helius API');
        }
    } catch (error) {
        console.error('Error checking balance:', error);
        await this.bot.sendMessage(chatId, "❌ Error checking wallet balance. Please try again.");
    }
}

async showUserWallets(msg) {
    try {
        const userSettings = this.getUserSettings(msg.chat.id);

        if (!userSettings.userWallets || userSettings.userWallets.length === 0) {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔑 Create Wallet', callback_data: 'command_create_wallet' }]
                ]
            };

            await this.bot.sendMessage(msg.chat.id,
                "You don't have any wallets yet. Would you like to create one?",
                { reply_markup: keyboard });
            return;
        }

        let message = "🔑 Your Wallets:\n\n";
        const keyboard = {
            inline_keyboard: []
        };

        for (const wallet of userSettings.userWallets) {
            message += `${wallet.label}\n`;
            message += `Address: \`${wallet.address}\`\n`;
            message += `Created: ${new Date(wallet.created).toLocaleDateString()}\n\n`;

            // Add button row for each wallet
            keyboard.inline_keyboard.push([
                { text: `💰 Check ${wallet.label} Balance`, callback_data: `check_balance:${wallet.address}` }
            ]);
        }

        // Add create wallet button
        keyboard.inline_keyboard.push([
            { text: '🔑 Create New Wallet', callback_data: 'command_create_wallet' }
        ]);

        await this.bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error showing user wallets:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error retrieving wallets. Please try again.");
    }
}

async handleDeposit(msg) {
    try {
        const userSettings = this.getUserSettings(msg.chat.id);

        if (!userSettings.userWallets || userSettings.userWallets.length === 0) {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔑 Create Wallet', callback_data: 'command_create_wallet' }]
                ]
            };

            await this.bot.sendMessage(msg.chat.id,
                "You don't have any wallets yet. Would you like to create one?",
                { reply_markup: keyboard });
            return;
        }

        const keyboard = {
            inline_keyboard: userSettings.userWallets.map(wallet => [{
                text: `${wallet.label} (${wallet.address.slice(0, 8)}...)`,
                callback_data: `deposit:${wallet.address}`
            }])
        };

        await this.bot.sendMessage(msg.chat.id, "Select a wallet to deposit to:", {
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error handling deposit:', error);
        await this.bot.sendMessage(msg.chat.id, "❌ Error preparing deposit information. Please try again.");
    }
}

async showDepositInfo(chatId, walletAddress) {
    try {
        const userSettings = this.getUserSettings(chatId);
        const wallet = userSettings.userWallets.find(w => w.address === walletAddress);
        const walletName = wallet ? wallet.label : 'Wallet';

        const message = `📥 Deposit to ${walletName}\n\n` +
            `Address: \`${walletAddress}\`\n\n` +
            `Instructions:\n` +
            `1. Copy the address above\n` +
            `2. Send SOL or any SPL tokens to this address\n` +
            `3. Check your balance after the transaction is confirmed\n\n` +
            `Note: Transactions typically confirm within 15-30 seconds`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '💰 Check Balance', callback_data: `check_balance:${walletAddress}` }]
            ]
        };

        await this.bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

    } catch (error) {
        console.error('Error showing deposit info:', error);
        await this.bot.sendMessage(chatId, "❌ Error displaying deposit information. Please try again.");
    }
}



  //       async getTokenName(address) {
  //         try {
  //     // Add Solana token metadata lookup
  //     const tokenMint = new PublicKey(address);
  //     const metadataPDA = await Metadata.getPDA(tokenMint);
  //     const metadata = await Metadata.load(this.connection, metadataPDA);
  //     return metadata.data.data.name;
  // } catch (error) {
  //     return 'Unknown';
  // }
  //       }

  // Update sendAlert to include comprehensive token information
  async sendAlert(
    chatId,
    tokenAddress,
    tokenName,
    buyersMap,
    totalSolSpentOnToken,
    tokenData = null
  ) {
    try {
      const settings = this.getUserSettings(chatId);

      // 1) If tokenData wasn't passed in, fetch from CallStatic or fallback
      if (!tokenData) {
        try {
          const metadata = await this.getTokenMetadata(tokenAddress);
          const marketData = await this.getTokenMarketData(tokenAddress);
          const volumeData = await this.getTokenVolumeData(tokenAddress);
          tokenData = { metadata, marketData, volumeData };
        } catch (err) {
          console.log(`Error getting token data for alert: ${err.message}`);
        }
      }

      // 2) Extract relevant info
      const metadata = tokenData?.metadata || {};
      const marketData = tokenData?.marketData || {};
      const volumeData = tokenData?.volumeData || {};

      const displayName = metadata.symbol || tokenName || 'Unknown';
      const fullName = metadata.name || displayName;
      const priceUsd = marketData.priceUsd ? parseFloat(marketData.priceUsd).toFixed(8) : 'Unknown';
      const priceSol = marketData.priceSol ? parseFloat(marketData.priceSol).toFixed(8) : 'Unknown';
      const marketCap = marketData.marketCap
        ? `$${parseFloat(marketData.marketCap).toLocaleString()}`
        : 'Unknown';
      const holders = marketData.holders ? marketData.holders.toLocaleString() : null;
      const bondingProgress = marketData.bondingProgress
        ? `${(marketData.bondingProgress * 100).toFixed(2)}%`
        : null;

      // 3) Build a buyer list with nicknames
      const buyerList = [];
      for (const [addr, solSpent] of buyersMap.entries()) {
        const nickname = settings.wallets.get(addr) || addr;
        buyerList.push(`${nickname} (${solSpent.toFixed(4)} SOL)`);
      }
      const buyerText = buyerList.join('\n');

      // 4) Build a fancy ASCII layout
      const alertMessage = `
  <b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>
  <b>🔥 HIGH-CONFIDENCE TOKEN ALERT 🔥</b>
  <b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>

  <b>Token:</b> <code>${displayName}</code>
  ${fullName !== displayName ? `<b>Name:</b> ${fullName}\n` : ''}
  <b>Address:</b> <code>${tokenAddress}</code>

  <b>Buyers (${buyersMap.size}):</b>
  ${buyerText}

  <b>Collective SOL Spent:</b> ${totalSolSpentOnToken.toFixed(4)} SOL

  <b>Price:</b> $${priceUsd} (${priceSol} SOL)
  <b>Market Cap:</b> ${marketCap}
  ${holders ? `<b>Holders:</b> ${holders}\n` : ''}
  ${bondingProgress ? `<b>Bonding Progress:</b> ${bondingProgress}\n` : ''}

  <b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>
  <b>Social:</b>
  ${metadata.twitter ? `• <a href="https://twitter.com/${metadata.twitter.replace('@','')}">Twitter</a>\n` : ''}
  ${metadata.telegram ? `• <a href="${metadata.telegram}">Telegram</a>\n` : ''}
  ${metadata.website ? `• <a href="${metadata.website}">Website</a>\n` : ''}

  <b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>
  <b>Trade on:</b>
  • <a href="https://pump.fun/token/${tokenAddress}">Pump.fun</a>
  • <a href="https://photon-sol.tinyastro.io/en/lp/${tokenAddress}">Photon</a>
  • <a href="https://jup.ag/swap/SOL-${tokenAddress}">Jupiter</a>
  • <a href="https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenAddress}">Raydium</a>
  <b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>
  `;

      // 5) Send the message in HTML mode
      await this.bot.sendMessage(chatId, alertMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });

      console.log(`✅ Alert sent for ${displayName} (${tokenAddress.slice(0, 8)}...)`);
    } catch (error) {
      console.error('Error sending alert:', error);
    }
  }

        getUserSettings(chatId) {
            if (!this.userSettings.has(chatId)) {
                this.userSettings.set(chatId, {
                    ...this.defaultSettings,
                    wallets: new Map()
                });
            }
            return this.userSettings.get(chatId);
        }
    }

    try {
        // Simply create the instance - constructor handles config loading
        const tracker = new WalletTracker();

        // Optional: Log success after object creation if initialize() doesn't log completion
        // console.log("INFO: WalletTracker instance created. Bot is starting...");

    } catch (error) {
        // Catch errors thrown from the constructor (e.g., missing BOT_TOKEN)
        console.error("ERROR: Failed to initialize WalletTracker:");
        console.error(error.message);
        process.exit(1); // Exit the process if initialization fails critically
    }

    // Global error handlers remain important
    process.on('unhandledRejection', (error) => {
        console.error('FATAL: Unhandled Promise Rejection:', error);
        // Consider if you need to exit or alert here depending on the error
    });

    process.on('uncaughtException', (error) => {
        console.error('FATAL: Uncaught Exception:', error);
        process.exit(1); // Often best to exit on uncaught exceptions
    });
