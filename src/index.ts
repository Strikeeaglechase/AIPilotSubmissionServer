import "reflect-metadata";

import { IntentsBitField, Partials } from "discord.js";
import { config as dotenvConfig } from "dotenv";
import isElevated from "is-elevated";
import FrameworkClient from "strike-discord-framework";
import { FrameworkClientOptions } from "strike-discord-framework/dist/interfaces";

import { Application } from "./application.js";

dotenvConfig();
const f = IntentsBitField.Flags;
export const isDev = process.env.IS_DEV == "true";
const frameworkOptions: FrameworkClientOptions = {
	commandsPath: `${process.cwd()}/commands/`,
	databaseOpts: {
		databaseName: "ai-pilot" + (isDev ? "-dev" : ""),
		url: process.env.DB_URL
	},
	loggerOpts: {
		filePath: `${process.cwd()}/../logs/`,
		logChannels: {
			INFO: process.env.LOG_CHANNEL,
			ERROR: process.env.ERR_CHANNEL,
			WARN: process.env.ERR_CHANNEL
		},
		logToFile: true
	},
	defaultPrefix: ".",
	name: "AIPilot",
	token: process.env.TOKEN,
	ownerID: "272143648114606083",
	slashCommandDevServer: isDev ? "647138462444552213" : "1015729793733492756",
	dmPrefixOnPing: true,
	dmErrorSilently: false,
	permErrorSilently: false,
	clientOptions: {
		partials: [Partials.Channel, Partials.GuildMember],
		intents: f.Guilds | f.GuildMembers | f.GuildModeration
	}
};

const frameClient = new FrameworkClient(frameworkOptions);
const application = new Application(frameClient);

async function init() {
	if (await isElevated()) {
		console.log(`Program launched with elevated permissions, exiting for safety with sandboxing.`);
		process.exit(1);
	}

	await frameClient.init(application);
	await application.init();

	process.on("unhandledRejection", error => {
		application.log.error(error);
	});
	process.on("uncaughtException", error => {
		application.log.error(error);
	});
}
init();
