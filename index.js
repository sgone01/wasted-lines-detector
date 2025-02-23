const core = require('@actions/core');
const github = require('@actions/github');
const { createAppAuth } = require('@octokit/auth-app');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');

async function getOctokitInstance() {
    try {
        const appId = process.env.GITHUB_APP_ID || core.getInput('github_app_id');
        const privateKey = process.env.GITHUB_PRIVATE_KEY || core.getInput('github_private_key');

        if (!appId || !privateKey) {
            throw new Error("❌ Missing GitHub App credentials.");
        }

        // Authenticate as GitHub App
        const auth = createAppAuth({ appId, privateKey });
        const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

        // Retrieve installation ID
        const { data: installations } = await appOctokit.rest.apps.listInstallations();
        if (!installations.length) throw new Error("❌ No installations found.");

        const installationId = installations[0].id;
        const installationAuth = await auth({ type: "installation", installationId });

        return new Octokit({ auth: installationAuth.token });
    } catch (error) {
        core.setFailed(`❌ Failed to authenticate GitHub App. Error: ${error.message}`);
    }
}

async function run() {
    try {
        const octokit = await getOctokitInstance();
        if (!octokit) return;

        const { context } = github;
        const pr = context.payload.pull_request;
        if (!pr) return;

        console.log("PR Detected:", pr.number);

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        console.log("Fetched PR Files:", files.data.map(f => f.filename));

        const comments = await analyzeFiles(files.data, octokit, context.repo, pr.head.ref);
        console.log("AI Suggestions:", comments);

        if (comments.length > 0) {
            await postReviewComments(octokit, comments, context.repo, pr.number);
        }
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

async function analyzeFiles(files, octokit, repo, branch) {
    let comments = [];

    for (const file of files) {
        if (!isSupportedFile(file.filename)) continue;

        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, branch);
        if (!content) continue;

        const suggestion = await getSuggestionsFromGeminiAI(content, file.filename);
        if (suggestion) {
            comments.push({
                file: file.filename,
                line: extractLineNumber(file), // Correct line number
                body: `#### 📂 [${file.filename}](https://github.com/${repo.owner}/${repo.repo}/blob/${branch}/${file.filename})\n\n\`\`\`\n${suggestion}\n\`\`\``
            });
        }
    }

    return comments;
}

async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    return Buffer.from(response.data.content, 'base64').toString('utf-8');
}

async function getSuggestionsFromGeminiAI(content, filename) {
    const language = getLanguageFromFilename(filename);
    const apiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text: `Improve this ${language} code. Return only the corrected code inside a code block, no explanations:\n\n${content}` }] }]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, { headers: { 'Content-Type': 'application/json' } });
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text.trim() || null;
    } catch {
        return null;
    }
}

async function postReviewComments(octokit, comments, repo, prNumber) {
    if (comments.length === 0) return;

    await octokit.rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        event: "COMMENT",
        body: `### 🚀 Wasted Lines Detector Report\n\n${comments.map(c => c.body).join("\n\n")}`,
        comments: comments.map(c => ({
            path: c.file,
            position: c.line,
            body: c.body
        }))
    });

    console.log("✅ Review comments posted!");
}

function extractLineNumber(file) {
    if (!file.patch) return 1;
    const match = file.patch.match(/^@@ -\d+,\d+ \+(\d+),/);
    return match ? parseInt(match[1], 10) : 1;
}

function getLanguageFromFilename(filename) {
    if (filename.endsWith('.js')) return 'JavaScript';
    if (filename.endsWith('.py')) return 'Python';
    if (filename.endsWith('.sh')) return 'Shell';
    if (filename.endsWith('.rb')) return 'Ruby';
    if (filename.endsWith('.groovy')) return 'Groovy';
    return 'Unknown';
}

function isSupportedFile(filename) {
    return ['.js', '.py', '.sh', '.rb', '.groovy'].some(ext => filename.endsWith(ext));
}

run();
