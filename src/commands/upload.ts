import { Attachment, MessageFlags } from "discord.js";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import { SlashCommand, SlashCommandAutocompleteEvent, SlashCommandEvent } from "strike-discord-framework/dist/slashCommand.js";
import { SArg } from "strike-discord-framework/dist/slashCommandArgumentParser.js";
import { v4 as uuidv4 } from "uuid";

import { AIPilot, aipNameRegex, aipUploadDir, AIPVersion, Application } from "../application.js";
import { interactionConfirm } from "../iterConfirm.js";

class Upload extends SlashCommand {
	name = "upload";
	description = "Uploads a new AIP version.";

	public override async run(
		{ interaction, app, framework }: SlashCommandEvent<Application>,
		@SArg({ autocomplete: true }) name: string,
		@SArg() attachment: Attachment
	) {
		if (!aipNameRegex.test(name)) {
			await interaction.reply(framework.error(`AIP name must match the regex \`${aipNameRegex.source}\`.`, true));
			return;
		}

		// let aip: AIPilot = await app.aips.collection.findOne({ name });
		let aip: AIPilot = await app.getAipByName(name);
		if (aip && aip.ownerId !== interaction.user.id) {
			await interaction.reply(framework.error(`You do not own the AIP with name ${name}.`, true));
			return;
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		if (!aip) {
			const result = await interactionConfirm(`AIP with name ${name} does not exist, create new?`, interaction, true);
			if (!result) return;

			aip = {
				id: uuidv4(),
				name,
				ownerId: interaction.user.id,
				current: { version: 0, uploadId: "", failCount: 0 },
				versions: []
			};

			await app.aips.collection.insertOne(aip);
		}

		const dlId = uuidv4();
		await new Promise<void>(async res => {
			const req = await fetch(attachment.url);
			const outStream = fs.createWriteStream(path.join(aipUploadDir, `${dlId}.zip`));
			req.body.pipe(outStream);

			outStream.on("finish", () => res());
		});

		const newVersion: AIPVersion = {
			version: aip.current.version + 1,
			uploadId: dlId,
			failCount: 0
		};

		await app.aips.collection.updateOne(
			{ id: aip.id },
			{
				$set: { current: newVersion },
				$push: { versions: newVersion }
			}
		);

		await interaction.editReply(framework.success(`Uploaded version \`${newVersion.version}\` of AIP **${name}**.`, true));

		app.startMatchLoop();
	}

	public override async handleAutocomplete({ interaction, app }: SlashCommandAutocompleteEvent<Application>) {
		const focusedValue = interaction.options.getFocused(true);
		if (focusedValue.name != "name") {
			await interaction.respond([]);
			return;
		}

		const options = await app.aips.collection
			.find({ ownerId: interaction.user.id }, { projection: { name: 1 } })
			.map(a => ({ name: a.name, value: a.name }))
			.toArray();

		await interaction.respond(options);
	}
}

export default Upload;
