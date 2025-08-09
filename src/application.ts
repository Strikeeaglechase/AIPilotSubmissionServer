import { spawn } from "child_process";
import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import FrameworkClient from "strike-discord-framework";
import { CollectionManager } from "strike-discord-framework/dist/collectionManager.js";
import Logger from "strike-discord-framework/dist/logger.js";
import { v4 as uuidv4 } from "uuid";

interface AIPilot {
	name: string;
	ownerId: string;
	current: AIPVersion;
	versions: AIPVersion[];
	id: string;
}

interface AIPVersion {
	version: number;
	uploadId: string;
}

enum Team {
	Allied,
	Enemy,
	Unknown
}

interface MatchResult {
	id: string;
	teamA: { aipId: string; version: number };
	teamB: { aipId: string; version: number };
	winner: Team;
	manualRun: boolean;
	normalizedName: string;
	createdAt: number;
}

interface MatchExecutionResult {
	result: MatchResult;
	simFolderPath: string;
	normalizedName: string;
}

const aipUploadDir = "../uploads/";
const matchLogPath = "../matchLogs/";
const simResults = "../simResults/";
const matchesPer = 10;
const aipNameRegex = /^[\w-]{3,32}$/i;
class Application {
	public log: Logger;

	private api: express.Express;

	public aips: CollectionManager<AIPilot>;
	public matchResults: CollectionManager<MatchResult>;

	private matchLoopRunning = false;

	constructor(private framework: FrameworkClient) {
		this.log = this.framework.log;

		if (!fs.existsSync(aipUploadDir)) fs.mkdirSync(aipUploadDir);
		if (!fs.existsSync(matchLogPath)) fs.mkdirSync(matchLogPath);
		if (!fs.existsSync(simResults)) fs.mkdirSync(simResults);
	}

	public async init() {
		this.aips = await this.framework.database.collection("aips", false, "id");
		this.matchResults = await this.framework.database.collection("matchResults", false, "id");

		this.setupApi();
		this.checkRunNextMatch();
	}

	private setupApi() {
		this.api = express();
		this.api.use(cors());
		// this.api.use("/aipilot", express.raw({ type: "application/zip", limit: "100mb" }));
		// this.api.use("/aipilot", express.raw({ type: "application/octet-stream", limit: "25mb" }));
		// this.api.use(express.json());

		this.api.get("/aipilot", async (req, res) => {
			let query = {};
			const nameQuery = req.query.name as string;
			if (nameQuery) query["name"] = nameQuery;

			const idQuery = req.query.id as string;
			if (idQuery) query["id"] = idQuery;

			const aips = await this.aips.collection.find(query).toArray();
			res.json(aips);
		});

		this.api.post("/aipilot", async (req, res) => {
			const authKey = req.headers["authorization"];
			if (authKey != process.env.API_AUTH_KEY) {
				res.status(403).json({ error: "Invalid authorization key." });
				return;
			}

			const aipName = req.query.name as string;
			if (!aipName) {
				res.status(400).json({ error: "Missing required parameter: name" });
				return;
			}

			let aip: AIPilot = await this.aips.collection.findOne({ name: aipName });
			const ownerId = req.query.ownerId as string;
			if (!aip && !ownerId) {
				res.status(400).json({ error: "Missing required parameter: ownerId (required for new AIPs)" });
				return;
			}

			if (!aip) {
				if (!aipNameRegex.test(aipName)) {
					res.status(400).json({ error: `AIP name must match the regex ${aipNameRegex.source}` });
					return;
				}

				aip = {
					id: uuidv4(),
					name: aipName,
					ownerId: ownerId,
					current: { version: 0, uploadId: "" },
					versions: []
				};

				await this.aips.collection.insertOne(aip);
			}

			const dlId = uuidv4();
			await new Promise<void>(async res => {
				const outStream = fs.createWriteStream(path.join(aipUploadDir, `${dlId}.zip`), "binary");
				req.pipe(outStream);

				outStream.on("finish", () => res());
			});

			const newVersion: AIPVersion = {
				version: aip.current.version + 1,
				uploadId: dlId
			};

			await this.aips.collection.updateOne(
				{ id: aip.id },
				{
					$set: { current: newVersion },
					$push: { versions: newVersion }
				}
			);

			this.startMatchLoop();

			res.json({ uploadId: dlId, version: newVersion.version });
		});

		this.api.get("/matches", async (req, res) => {
			let query = {};
			const aipIdQuery = req.query.aipId as string;
			const versionQuery = req.query.version as string;

			if (aipIdQuery && versionQuery)
				query["$or"] = [{ "teamA.aipId": aipIdQuery, "teamA.version": versionQuery }, { "teamB.aipId": aipIdQuery }, { "teamB.version": versionQuery }];
			else if (aipIdQuery) query["$or"] = [{ "teamA.aipId": aipIdQuery }, { "teamB.aipId": aipIdQuery }];
			else if (versionQuery) query["$or"] = [{ "teamA.version": versionQuery }, { "teamB.version": versionQuery }];

			const idQuery = req.query.id as string;
			if (idQuery) query["id"] = idQuery;

			const matches = await this.matchResults.collection.find(query).toArray();
			res.json(matches);
		});

		this.api.get("/fight/", async (req, res) => {
			const aipId1 = req.query.aipId1 as string;
			const aipId2 = req.query.aipId2 as string;

			if (!aipId1 || !aipId2) {
				res.status(400).json({ error: "Missing required parameters: aipId1, aipId2" });
				return;
			}

			const aips = await this.aips.collection.find({ id: { $in: [aipId1, aipId2] } }).toArray();
			if (aips.length != 2) {
				res.status(404).json({ error: "One or both AIPs not found." });
				return;
			}

			const result = this.runMatch([aips[0], aips[1]], true);
			res.json({ matchId: result.id });

			const execResults = await result.prom;
			const vtgrOutPath = path.join(execResults.simFolderPath, "..", execResults.normalizedName + ".vtgr");
			const hcConvertProm = await this.convertRecording(path.join(execResults.simFolderPath, "recording.json"), vtgrOutPath);

			if (!hcConvertProm) {
				this.log.error(`Failed to convert recording for match ${result.id}`);
				return;
			}
		});

		this.api.get("/replay", async (req, res) => {
			const matchId = req.query.matchId as string;
			if (!matchId) {
				res.status(400).json({ error: "Missing required parameter: matchId" });
				return;
			}

			const match = await this.matchResults.collection.findOne({ id: matchId });
			if (!match) {
				res.status(404).json({ error: "Match not found." });
				return;
			}

			const vtgrPath = path.join(simResults, match.normalizedName + ".vtgr");
			if (!fs.existsSync(vtgrPath)) {
				res.status(404).json({ error: "Replay file not found." });
				return;
			}

			res.download(vtgrPath, match.normalizedName + ".vtgr");
		});

		this.api.listen(parseInt(process.env.API_PORT), () => {
			console.log(`API opened on ${process.env.API_PORT}`);
		});
	}

	public startMatchLoop() {
		if (this.matchLoopRunning) {
			this.log.warn(`Match loop is already running, skipping start.`);
			return;
		}

		this.log.info(`Starting match loop...`);
		this.checkRunNextMatch();
	}

	private async checkRunNextMatch() {
		this.matchLoopRunning = true;

		const nextMatch = await this.getNextMatchToRun();
		if (nextMatch) {
			this.log.info(`Found next match to run: ${nextMatch[0].name} vs ${nextMatch[1].name}`);
			await this.runMatch(nextMatch).prom;
			setTimeout(() => this.checkRunNextMatch());
		}

		this.matchLoopRunning = false;
	}

	public runMatch(aips: [AIPilot, AIPilot], manualMatchRun = false): { prom: Promise<MatchExecutionResult>; id: string } {
		const teamRng = Math.random() < 0.5;
		const allied = teamRng ? aips[0] : aips[1];
		const enemy = teamRng ? aips[1] : aips[0];

		this.log.info(`Starting match between AIP ${allied.name} v${allied.current.version} (Allied) and AIP ${enemy.name} v${enemy.current.version} (Enemy)`);

		const aPath = path.resolve(path.join(aipUploadDir, `${allied.current.uploadId}.zip`));
		const ePath = path.resolve(path.join(aipUploadDir, `${enemy.current.uploadId}.zip`));
		const mapPath = path.resolve(`../Map/`);

		const args = [
			"run",
			"--rm",
			"--mount",
			`type=bind,src=${aPath},dst=/app/clients/allied.zip,readonly`,
			"--mount",
			`type=bind,src=${ePath},dst=/app/clients/enemy.zip,readonly`,
			"--mount",
			`type=bind,src=${mapPath},dst=/app/Map/,readonly`,
			"--memory=1g",
			"--memory-swap=1g",
			"--cpus=1",
			"--pids-limit=100",
			"--name",
			`aip-match-${allied.id}-${enemy.id}`
		];

		const sortedAips = aips.toSorted((a, b) => a.name.localeCompare(b.name));
		const normalizedName = `${sortedAips[0].name}_v${sortedAips[0].current.version}_vs_${sortedAips[1].name}_v${sortedAips[1].current.version}`;

		if (manualMatchRun) {
			const outPath = path.resolve(path.join(simResults, normalizedName));
			if (fs.existsSync(outPath)) fs.rmSync(outPath, { recursive: true });
			fs.mkdirSync(outPath);

			args.push(`--mount`, `type=bind,src=${outPath},dst=/sim/`);
		}

		args.push(`aip:latest`);

		const child = spawn(`docker`, args, {});

		const logStream = fs.createWriteStream(path.join(matchLogPath, normalizedName + ".log"), { flags: "a" });
		logStream.write(
			`[${new Date().toISOString()}] Starting match between AIP ${allied.name} v${allied.current.version} (Allied) and AIP ${enemy.name} v${
				enemy.current.version
			} (Enemy)\n`
		);

		child.stdout.pipe(logStream);

		let team: Team = Team.Unknown;
		child.stdout.on("data", data => {
			const match = data.toString().match(/\[INFO\] \[HSGE\] Winning team: (Allied|Enemy|Unknown)/);
			if (match) {
				const winningTeam = match[1];
				if (winningTeam == "Allied") team = Team.Allied;
				else if (winningTeam == "Enemy") team = Team.Enemy;
				else team = Team.Unknown;
			}
		});
		child.stderr.pipe(logStream);

		let res: (result: MatchExecutionResult) => void;
		const closeProm = new Promise<MatchExecutionResult>(resolve => (res = resolve));
		const matchId = uuidv4();

		child.on("close", async code => {
			this.log.info(`Match finished with code ${code}. Winning team: ${Team[team]}`);
			logStream.write(`[${new Date().toISOString()}] Match finished with code ${code}. Winning team: ${team}\n`);
			logStream.end();

			if (code != 0) {
				res(null);
				return;
			}

			const result: MatchResult = {
				id: matchId,
				teamA: { aipId: allied.id, version: allied.current.version },
				teamB: { aipId: enemy.id, version: enemy.current.version },
				winner: team,
				manualRun: manualMatchRun,
				createdAt: Date.now(),
				normalizedName: normalizedName
			};

			const execResult: MatchExecutionResult = {
				result,
				simFolderPath: manualMatchRun ? path.join(simResults, normalizedName) : null,
				normalizedName: normalizedName
			};

			if (team == Team.Unknown) {
				this.log.error(`Match ended with unknown team, skipping result logging.`);
				res(execResult);
				return;
			}

			// if (manualMatchRun) {
			// 	this.log.info(`Skipping saving result due to manual match run.`);
			// 	res(execResult);
			// 	return;
			// }

			await this.matchResults.collection.insertOne(result);
			this.log.info(`Match result logged successfully.`);
			res(execResult);
		});

		return { prom: closeProm, id: matchId };
	}

	public convertRecording(inputPath: string, outputPath: string): Promise<boolean> {
		return new Promise(res => {
			const args = ["--convert", "--input", inputPath, "--output", outputPath, "--map", "../Map"];
			const child = spawn(process.env.HC_PATH, args);

			child.on("close", code => {
				if (code != 0) {
					this.log.error(`Headless Client conversion failed with code ${code}.`);
					res(false);
					return;
				}

				this.log.info(`Headless Client conversion completed successfully.`);
				res(true);
			});
		});
	}

	private async getNextMatchToRun(): Promise<[AIPilot, AIPilot]> {
		const aips = await this.aips.collection.find().toArray();

		for (const aip of aips) {
			const history = await this.getHistory(aip);

			for (const otherAip of aips) {
				if (otherAip.id == aip.id) continue;
				const matchesAgainst = history.filter(m => m.teamA.aipId == otherAip.id || m.teamB.aipId == otherAip.id).length;

				if (matchesAgainst < matchesPer) {
					return [aip, otherAip];
				}
			}
		}

		return null;
	}

	public async getHistory(aip: AIPilot) {
		return await this.matchResults.collection
			.find({
				$or: [
					{ "teamA.aipId": aip.id, "teamA.version": aip.current.version },
					{ "teamB.aipId": aip.id, "teamB.version": aip.current.version }
				]
			})
			.toArray();
	}
}

export { Application, AIPilot, AIPVersion, aipUploadDir, aipNameRegex, Team, MatchResult };
