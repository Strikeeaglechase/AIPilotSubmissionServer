import { SlashCommand, SlashCommandAutocompleteEvent, SlashCommandEvent } from "strike-discord-framework/dist/slashCommand.js";
import { SArg } from "strike-discord-framework/dist/slashCommandArgumentParser.js";

import { EmbedBuilder } from "@discordjs/builders";

import { Application, MatchResult, maxFails, Team } from "../application.js";

function winId(result: MatchResult) {
	return result.winner == Team.Allied ? result.teamA.aipId : result.teamB.aipId;
}

function table(data: (string | number)[][], tEntryMaxLen = 16) {
	const widths = data[0].map((_, i) => Math.max(...data.map(row => String(row[i]).length)));
	return data.map(row => row.map((val, i) => String(val).padEnd(widths[i]).substring(0, tEntryMaxLen)).join(" "));
}

class Stats extends SlashCommand {
	name = "stats";
	description = "Gets an AIP's Win/Loss stats";

	public override async run({ interaction, app, framework }: SlashCommandEvent<Application>, @SArg({ autocomplete: true }) name: string) {
		const aip = await app.getAipByName(name);
		if (!aip) {
			await interaction.reply(framework.error(`AIP with name \`${name}\` does not exist.`, true));
			return;
		}

		const history = await app.getHistory(aip);
		if (!history || history.length == 0) {
			await interaction.reply(framework.error(`No match history found for AIP \`${name}\`.`, true));
			return;
		}

		const winCount = history.filter(m => winId(m) == aip.id).length;
		const lossCount = history.length - winCount;
		const winRate = ((winCount / history.length) * 100).toFixed(0);

		const historyAgainst: Record<string, { wins: number; losses: number }> = {};
		history.forEach(m => {
			const opId = m.teamA.aipId == aip.id ? m.teamB.aipId : m.teamA.aipId;
			if (!historyAgainst[opId]) historyAgainst[opId] = { wins: 0, losses: 0 };

			if (winId(m) == aip.id) {
				historyAgainst[opId].wins++;
			} else {
				historyAgainst[opId].losses++;
			}
		});

		const historyAgainstTable: (string | number)[][] = [["Name", "Wins", "Losses", "Win rate"]];
		for (const [opId, stats] of Object.entries(historyAgainst)) {
			const opAip = await app.aips.collection.findOne({ id: opId });
			if (opAip) {
				historyAgainstTable.push([opAip.name, stats.wins, stats.losses, ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) + "%"]);
			}
		}

		const embed = new EmbedBuilder();
		embed.setTitle(`AIP Stats for ${aip.name} v${aip.current.version}`);
		let description = `**Owner:** <@${aip.ownerId}>\n`;
		description += `**Total Matches:** ${history.length}\n`;
		description += `**Wins-Loss-Win rate:** ${winCount} - ${lossCount} - ${winRate}%\n`;
		description += `\`\`\`\n${table(historyAgainstTable).join("\n")}\n\`\`\``;
		embed.setDescription(description);

		if (aip.current.failCount >= maxFails) {
			embed.setColor(0xff0000);
			embed.setFooter({ text: "This AIP has failed too many matches and is disabled." });
		}

		await interaction.reply({ embeds: [embed] });
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

export default Stats;
