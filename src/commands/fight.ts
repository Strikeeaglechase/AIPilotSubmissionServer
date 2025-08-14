import archiver from "archiver";
import { EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";
import { SlashCommand, SlashCommandAutocompleteEvent, SlashCommandEvent } from "strike-discord-framework/dist/slashCommand.js";
import { SArg } from "strike-discord-framework/dist/slashCommandArgumentParser.js";
import { v4 as uuidv4 } from "uuid";

import { Application, replayFolder, Team } from "../application.js";

function zipToBuffer(dirPath: string) {
	const archive = archiver("zip");
	archive.directory(dirPath, false);

	return new Promise<Buffer>((resolve, reject) => {
		const buffers: Buffer[] = [];
		archive.on("data", data => buffers.push(data));
		archive.on("end", () => resolve(Buffer.concat(buffers)));
		archive.on("error", err => reject(err));
		archive.finalize();
	});
}

class Fight extends SlashCommand {
	name = "fight";
	description = "Runs a fight between two AIPs";

	public override async run(
		{ interaction, app, framework }: SlashCommandEvent<Application>,
		@SArg({ autocomplete: true }) ai1: string,
		@SArg({ autocomplete: true }) ai2: string
	) {
		const aip1 = await app.getAipByName(ai1);
		const aip2 = await app.getAipByName(ai2);

		if (!aip1) {
			await interaction.reply(framework.error(`AIP with name \`${ai1}\` does not exist.`, true));
			return;
		}

		if (!aip2) {
			await interaction.reply(framework.error(`AIP with name \`${ai2}\` does not exist.`, true));
			return;
		}

		const matchEmbed = new EmbedBuilder();
		matchEmbed.setTitle(`${aip1.name} v${aip1.current.version} vs ${aip2.name} v${aip2.current.version}`);
		matchEmbed.setDescription(`Simulation running...`);
		await interaction.reply({ embeds: [matchEmbed] });

		const execResults = await app.runMatch([aip1, aip2], true).prom;
		if (!execResults) {
			await interaction.editReply(framework.error("An error occurred while running the match.", true));
			return;
		}

		const winnerAipResult = execResults.result.winner == Team.Allied ? execResults.result.teamA : execResults.result.teamB;
		const winnerAip = [aip1, aip2].find(a => a.id == winnerAipResult.aipId);
		matchEmbed.setDescription(
			`Simulation finished, finalizing results...\nWinner: (${Team[execResults.result.winner]}) \`${winnerAip.name} v${winnerAip.current.version}\``
		);

		const replyProm = interaction.editReply({ embeds: [matchEmbed] });
		const zipProm = zipToBuffer(execResults.simFolderPath);
		const replayId = uuidv4();
		const vtgrOutPath = path.join(replayFolder, execResults.normalizedName, replayId + ".vtgr");
		const hcConvertProm = app.convertRecording(path.join(execResults.simFolderPath, "recording.json"), vtgrOutPath);
		await Promise.all([replyProm, zipProm, hcConvertProm]);

		await app.matchResults.collection.updateOne({ id: execResults.result.id }, { $set: { replayId: replayId } });
		const zipBuffer = await zipProm;
		matchEmbed.setDescription(`Simulation finished!\nWinner: (${Team[execResults.result.winner]}) \`${winnerAip.name} v${winnerAip.current.version}\``);

		const vtgrStream = fs.createReadStream(vtgrOutPath);
		await interaction.editReply({
			embeds: [matchEmbed],
			files: [
				{ attachment: zipBuffer, name: "simulation.zip" },
				{ attachment: vtgrStream, name: execResults.normalizedName + ".vtgr" }
			]
		});
	}

	public override async handleAutocomplete({ interaction, app }: SlashCommandAutocompleteEvent<Application>) {
		const focusedValue = interaction.options.getFocused(true);
		if (focusedValue.name != "ai1" && focusedValue.name != "ai2") {
			await interaction.respond([]);
			return;
		}

		const options = await app.aips.collection
			.find({}, { projection: { name: 1 } })
			.map(a => ({ name: a.name, value: a.name }))
			.toArray();

		await interaction.respond(options);
	}
}

export default Fight;
