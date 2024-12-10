import { request, gql } from "graphql-request";
import { shortString } from "starknet";

const TEST_API = "https://api.cartridge.gg/x/sepolia-rc-16/torii/graphql";
const PROD_API = "https://api.cartridge.gg/x/realms-world-5/torii/graphql";

// Using TEST_API for development
const ENDPOINT = TEST_API;

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

const REALM_QUERYOLD = gql`
  query S0EternumSettleRealmDataModels($x: Int!, $y: Int!) {
    s0EternumSettleRealmDataModels(where: { x: { _eq: $x }, y: { _eq: $y } }) {
      edges {
        node {
          realm_name
          owner_name
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
  constructor() {
    this.knownBattles = new Set();
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

  async checkForNewBattles() {
    try {
      const data = await request(ENDPOINT, BATTLE_QUERY);
      const battles = data.s0EternumBattleStartDataModels.edges;

      battles.forEach(({ node: battle }) => {
        if (!this.knownBattles.has(battle.battle_entity_id)) {
          this.knownBattles.add(battle.battle_entity_id);
          this.handleNewBattle(battle);
        }
      });
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

    // Log le message formaté
    console.log(this.formatBattleMessage(battle, realmInfo));

    // Log détaillé existant pour les données complètes
    console.log("Battle details:", {
      battleId: battle.battle_entity_id,
      attacker: {
        name: this.decodeName(battle.attacker_name),
        address: battle.attacker,
        armyId: battle.attacker_army_entity_id,
      },
      defender: {
        name: this.decodeName(battle.defender_name),
        address: battle.defender,
        armyId: battle.defender_army_entity_id,
      },
      location: {
        x: battle.x,
        y: battle.y,
        realmInfo: realmInfo
          ? {
              name: realmInfo.name,
              ownerName: realmInfo.ownerName,
            }
          : null,
      },
      structureType: battle.structure_type,
      durationLeft: this.formatDuration(battle.duration_left),
      timestamp: this.formatTimestamp(battle.timestamp),
      rawData: {
        durationLeft: battle.duration_left,
        timestamp: battle.timestamp,
      },
    });
  }

  startMonitoring(interval = 10000) {
    console.log("Starting battle monitoring...");
    this.checkForNewBattles();
    setInterval(() => this.checkForNewBattles(), interval);
  }
}

// Start the monitor
const monitor = new BattleMonitor();
monitor.startMonitoring();
