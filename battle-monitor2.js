import { request, gql } from "graphql-request";
import { shortString } from "starknet";
import { Bot, InlineKeyboard } from "grammy";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { conversations, createConversation } from "@grammyjs/conversations";
import { session } from "grammy";
import { freeStorage } from "@grammyjs/storage-free";

// Charger les variables d'environnement
dotenv.config();

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TEST_API = process.env.TEST_API;
const PROD_API = process.env.PROD_API;
const ENDPOINT = TEST_API;

// Création du bot
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const BATTLE_QUERY = gql`
  query S0EternumBattleStartDataModels {
    s0EternumBattleStartDataModels {
      totalCount
      edges {
        node {
          id
          event_id
          battle_entity_id
          attacker
          attacker_name
          attacker_army_entity_id
          defender_name
          defender
          defender_army_entity_id
          duration_left
          x
          y
          structure_type
          timestamp
        }
      }
    }
  }
`;

const REALM_QUERY = gql`
  query S0EternumSettleRealmDataModels($x: Int!, $y: Int!) {
    s0EternumSettleRealmDataModels(where: { x: $x, y: $y }) {
      edges {
        node {
          realm_name
          owner_name
        }
      }
    }
  }
`;

const OWNER_QUERY = gql`
  query GetOwner() {
    s0EternumOwnerModels {
      edges {
        node {
          entity_id
          address
        }
      }
      totalCount
    }
  }
`;

class BattleMonitor {
  constructor(bot) {
    this.bot = bot;
    this.knownBattles = new Set();
    this.initBot();
  }

  // Initialisation du bot avec les commandes
  async initBot() {
    // Add session middleware before conversations
    this.bot.use(
      session({
        initial: () => ({ awaitingUsername: false }),
        storage: freeStorage(process.env.TELEGRAM_BOT_TOKEN),
      })
    );

    // Add conversations middleware
    this.bot.use(conversations());

    // Bind the conversation handler to the class instance
    this.bot.use(createConversation(this.getUsernameConversation.bind(this)));

    // Commande start avec demande de username
    this.bot.command("start", async (ctx) => {
      const keyboard = new InlineKeyboard().text(
        "Register my username",
        "register_username"
      );

      await ctx.reply(
        "👋 Welcome to the Battle Monitor!\n\n" +
          "To receive battle notifications, please register your username.",
        { reply_markup: keyboard }
      );
    });

    // Gestionnaire pour le bouton "Register username"
    this.bot.callbackQuery("register_username", async (ctx) => {
      try {
        await ctx.conversation.enter("bound getUsernameConversation");
        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error starting username conversation:", error);
        await ctx.answerCallbackQuery("An error occurred. Please try again.");
      }
    });

    // Commande pour se désinscrire
    this.bot.command("unsubscribe", async (ctx) => {
      await this.removeUser(ctx.chat.id);
      await ctx.reply("You have been unsubscribed from battle notifications.");
    });

    // Handler pour obtenir le username
    this.bot.on("message:text", async (ctx) => {
      const username = ctx.message.text;
      const chatId = ctx.chat.id;

      if (ctx.session?.awaitingUsername) {
        await this.registerUser(chatId, username);
        ctx.session.awaitingUsername = false;
        await ctx.reply(
          "Thank you! You are now registered for battle notifications."
        );
      }
    });

    this.bot.start();
  }

  async registerUser(chatId, username) {
    try {
      const { data, error } = await supabase.from("users").upsert([
        {
          chat_id: chatId,
          username: username,
          created_at: new Date(),
        },
      ]);

      if (error) throw error;
      console.log(`User registered: ${username} (${chatId})`);
    } catch (error) {
      console.error("Error registering user:", error);
    }
  }

  async removeUser(chatId) {
    try {
      const { error } = await supabase
        .from("users")
        .delete()
        .eq("chat_id", chatId);

      if (error) throw error;
      console.log(`User unsubscribed: ${chatId}`);
    } catch (error) {
      console.error("Error removing user:", error);
    }
  }

  async getRegisteredUsers() {
    try {
      const { data, error } = await supabase
        .from("users")
        .select("chat_id, username");

      if (error) throw error;
      return data;
    } catch (error) {
      console.error("Error fetching users:", error);
      return [];
    }
  }

  decodeName(name) {
    try {
      return shortString.decodeShortString(name.toString());
    } catch (error) {
      console.error("Error decoding name:", error);
      return "Unknown";
    }
  }

  // Convertit un timestamp hex en date lisible
  formatTimestamp(hexTimestamp) {
    const timestamp = parseInt(hexTimestamp, 16) * 1000; // Conversion en millisecondes
    const date = new Date(timestamp);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    return `${date.getDate()} ${
      months[date.getMonth()]
    } ${date.getHours()}:${date.getMinutes().toString().padStart(2, "0")}`;
  }

  // Convertit la durée hex en minutes et secondes
  formatDuration(hexDuration) {
    const seconds = parseInt(hexDuration, 16);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  async getUsersByDefenderName(defenderName, realmOwnerName = null) {
    try {
      // Construire la requête pour chercher les deux noms
      let query = supabase.from("users").select("chat_id, username");

      if (realmOwnerName) {
        // Si on a un realm owner, on cherche les deux noms
        query = query.or(
          `username.eq.${defenderName},username.eq.${realmOwnerName}`
        );
      } else {
        // Sinon on cherche juste le defender
        query = query.eq("username", defenderName);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error("Error fetching users by defender name:", error);
      return [];
    }
  }

  async sendTelegramMessage(message, defenderName, realmInfo = null) {
    try {
      // Récupérer les utilisateurs concernés par cette attaque (defender et/ou realm owner)
      const targetUsers = await this.getUsersByDefenderName(
        defenderName,
        realmInfo?.ownerName
      );

      if (targetUsers.length === 0) {
        console.log(
          `No registered users found for defender: ${defenderName}${
            realmInfo?.ownerName
              ? ` or realm owner: ${realmInfo.ownerName}`
              : ""
          }`
        );
        return;
      }

      // Dédupliquer les utilisateurs au cas où quelqu'un serait à la fois defender et realm owner
      const uniqueUsers = Array.from(
        new Map(targetUsers.map((user) => [user.chat_id, user])).values()
      );

      for (const user of uniqueUsers) {
        try {
          await this.bot.api.sendMessage(user.chat_id, message, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          console.log(`Alert sent to ${user.username} (${user.chat_id})`);
        } catch (error) {
          console.error(`Error sending message to ${user.chat_id}:`, error);
          if (
            error.description.includes("blocked") ||
            error.description.includes("not found")
          ) {
            await this.removeUser(user.chat_id);
          }
        }
      }
    } catch (error) {
      console.error("Error in sendTelegramMessage:", error);
    }
  }

  formatTelegramMessage(battle, realmInfo) {
    const attackerName = this.decodeName(battle.attacker_name);
    const defenderName = this.decodeName(battle.defender_name);
    const duration = this.formatDuration(battle.duration_left);
    const time = this.formatTimestamp(battle.timestamp);

    let message = "";

    if (battle.structure_type === "Realm" && realmInfo) {
      message =
        `⚔️ <b>New Battle Alert!</b>\n\n` +
        `🗡 Attacker: <b>${attackerName}</b>\n` +
        `🏰 Target: <b>${realmInfo.name}</b> Realm\n` +
        `👑 Realm Owner: <b>${realmInfo.ownerName}</b>\n` +
        `📍 Location: (${battle.x}, ${battle.y})\n` +
        `⏱ Duration: ${duration}\n` +
        `🕒 Started at: ${time}`;
    } else {
      message =
        `⚔️ <b>New Battle Alert!</b>\n\n` +
        `🗡 Attacker: <b>${attackerName}</b>\n` +
        `🛡 Defender: <b>${defenderName}</b>\n` +
        `🎯 Target: ${battle.structure_type}\n` +
        `⏱ Duration: ${duration}\n` +
        `🕒 Started at: ${time}`;
    }

    return message;
  }

  async checkForNewBattles() {
    try {
      const data = await request(ENDPOINT, BATTLE_QUERY);
      const battles = data.s0EternumBattleStartDataModels.edges;

      for (const { node: battle } of battles) {
        if (!this.knownBattles.has(battle.battle_entity_id)) {
          this.knownBattles.add(battle.battle_entity_id);
          await this.handleNewBattle(battle);
        }
      }
    } catch (error) {
      console.error("Error fetching battles:", error);
    }
  }

  async getOwnerAddresses(entityIds) {
    console.log("1. Starting getOwnerAddresses with:", entityIds);
    try {
      const results = {};

      for (const id of entityIds) {
        const intId = parseInt(id);
        console.log("2. Querying for ID:", intId);

        const data = await request(ENDPOINT, OWNER_QUERY, { id: intId });
        console.log("3. Response for ID:", intId, data);

        // Trouver le nœud correspondant à l'ID recherché
        const matchingNode = data.s0EternumOwnerModels.edges.find(
          (edge) => parseInt(edge.node.entity_id) === intId
        );

        if (matchingNode) {
          results[id] = matchingNode.node.address;
        }
      }

      console.log("4. Final results:", results);
      return results;
    } catch (error) {
      console.error("Error fetching owners:", error);
      return {};
    }
  }

  async getRealmInfo(x, y) {
    try {
      const data = await request(ENDPOINT, REALM_QUERY, { x, y });
      const realm = data.s0EternumSettleRealmDataModels.edges[0]?.node;

      if (realm) {
        return {
          name: this.decodeName(realm.realm_name),
          ownerName: this.decodeName(realm.owner_name),
        };
      }
      return null;
    } catch (error) {
      console.error("Error fetching realm info:", error);
      return null;
    }
  }

  formatBattleMessage(battle, realmInfo) {
    const attackerName = this.decodeName(battle.attacker_name);
    const defenderName = this.decodeName(battle.defender_name);
    const duration = this.formatDuration(battle.duration_left);
    const time = this.formatTimestamp(battle.timestamp);

    if (battle.structure_type === "Realm" && realmInfo) {
      return `[${time}] ${attackerName} is attacking ${realmInfo.name} Realm (owned by ${realmInfo.ownerName}) - Battle will end in ${duration}`;
    } else {
      return `[${time}] ${attackerName} is attacking ${defenderName}'s ${battle.structure_type} - Battle will end in ${duration}`;
    }
  }

  async handleNewBattle(battle) {
    let realmInfo = null;
    if (battle.structure_type === "Realm") {
      realmInfo = await this.getRealmInfo(battle.x, battle.y);
    }

    // Log pour le monitoring général
    console.log(this.formatBattleMessage(battle, realmInfo));

    // Récupérer le nom du défenseur selon le type de structure
    const defenderName = this.decodeName(battle.defender_name);

    // Formatter et envoyer le message aux défenseurs concernés
    const telegramMessage = this.formatTelegramMessage(battle, realmInfo);
    await this.sendTelegramMessage(telegramMessage, defenderName, realmInfo);
  }

  startMonitoring(interval = 10000) {
    console.log("Starting battle monitoring...");
    this.checkForNewBattles();
    setInterval(() => this.checkForNewBattles(), interval);
  }

  // Add the conversation handler
  async getUsernameConversation(conversation, ctx) {
    await ctx.reply("Please enter your Cartridge Controller username:");
    const { message } = await conversation.wait();

    if (!message || !message.text) {
      await ctx.reply("Invalid input. Please try again with /start");
      return;
    }

    const username = message.text;
    const chatId = ctx.chat.id;
    console.log("message", message.text);
    console.log("chatId", chatId);
    try {
      await this.registerUser(chatId, username);
      await ctx.reply(
        "✅ Successfully registered! You will now receive battle notifications."
      );
    } catch (error) {
      console.error("Error in registration:", error);
      await ctx.reply("❌ Registration failed. Please try again with /start");
    }
  }
}

// Démarrage du moniteur
const monitor = new BattleMonitor(bot);
monitor.startMonitoring();

// Add a general error handler for the bot
bot.catch((err) => {
  console.error("Error in bot:", err);
});
