const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const { createAppAuth } = require("@octokit/auth-app");

async function run() {
    try {
        const appId = process.env.GITHUB_APP_ID || core.getInput('github_app_id');
        const privateKey = process.env.GITHUB_PRIVATE_KEY || core.getInput('github_private_key');
        const aiApiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');

        if (!appId || !privateKey || !aiApiKey) {
            core.setFailed("❌ Missing required credentials.");
            return;
        }

        const auth = createAppAuth({ appId, privateKey });
        const installationToken = await getInstallationToken(auth);
        if (!installationToken) {
            core.setFailed("❌ Failed to get GitHub App installation token.");
            return;
        }

        const octokit = github.getOctokit(installationToken);
        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) {
            core.setFailed("❌ No pull request found.");
            return;
        }

        const latestCommitSHA = pr.head.sha;

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        const fileSuggestions = await analyzeFiles(files.data, octokit, context.repo, pr, aiApiKey);

        if (Object.keys(fileSuggestions).length > 0) {
            await postReview(octokit, context.repo, pr, latestCommitSHA, fileSuggestions);
        }
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

async function getInstallationToken(auth) {
    try {
        const { token } = await auth({ type: "installation" });
        return token;
    } catch (error) {
        core.error(`Failed to authenticate GitHub App: ${error.message}`);
        return null;
    }
}

async function analyzeFiles(files, octokit, repo, pr, aiApiKey) {
    let fileSuggestions = {};

    for (const file of files) {
        if (!isSupportedFile(file.filename)) continue;

        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, pr.head.ref);
        if (!content) continue;

        const suggestions = await getSuggestionsFromGeminiAI(content, aiApiKey, file.filename);
        if (suggestions.length > 0) {
            fileSuggestions[file.filename] = {
                suggestions,
                patchPositions: await getPatchPositions(octokit, repo, pr, file.filename, suggestions),
            };
        }
    }

    return fileSuggestions;
}

async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    return Buffer.from(response.data.content, 'base64').toString('utf-8');
}

async function getSuggestionsFromGeminiAI(content, apiKey, filename) {
    const language = getLanguageFromFilename(filename);
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text: `Identify issues in this ${language} code and provide fixes. Return JSON with { "line": <line_number>, "issue": "<problem>", "suggestedFix": "<fixed_code>" } format:\n\n${content}` }] }]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, { headers: { 'Content-Type': 'application/json' } });
        return JSON.parse(response.data?.candidates?.[0]?.content?.parts?.[0]?.text.trim()) || [];
    } catch {
        return [];
    }
}

async function getPatchPositions(octokit, repo, pr, filename, suggestions) {
    let positions = {};
    
    const diff = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pr.number,
        mediaType: { format: 'diff' }
    });

    const lines = diff.data.split('\n');
    let fileDiff = false, currentLine = 0, position = 0;

    for (const line of lines) {
        if (line.startsWith('diff --git')) fileDiff = line.includes(filename);
        if (!fileDiff) continue;

        if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+,\d+ \+(\d+),/);
            if (match) currentLine = parseInt(match[1], 10) - 1;
            position = 0;
        } else if (fileDiff) {
            if (!line.startsWith('-')) currentLine++;
            if (!line.startsWith('+')) position++;
            suggestions.forEach(suggestion => {
                if (suggestion.line === currentLine) positions[suggestion.line] = position;
            });
        }
    }

    return positions;
}

async function postReview(octokit, repo, pr, commitSHA, fileSuggestions) {
    let reviewComments = [];

    for (const [filename, data] of Object.entries(fileSuggestions)) {
        const { suggestions, patchPositions } = data;

        suggestions.forEach(suggestion => {
            if (patchPositions[suggestion.line]) {
                reviewComments.push({
                    path: filename,
                    position: patchPositions[suggestion.line],
                    body: `🔹 **Issue:** ${suggestion.issue}\n\n**Suggested Fix:**\n\`\`\`${getLanguageFromFilename(filename).toLowerCase()}\n${suggestion.suggestedFix}\n\`\`\`\n📂 [View File](${getGitHubFileLink(repo, pr, filename)})`
                });
            }
        });
    }

    if (reviewComments.length > 0) {
        await octokit.rest.pulls.createReview({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: pr.number,
            commit_id: commitSHA,
            body: "### 🚀 Wasted Lines Detector Report",
            event: "COMMENT",
            comments: reviewComments
        });
    }
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

function getGitHubFileLink(repo, pr, filename) {
    return `https://github.com/${repo.owner}/${repo.repo}/blob/${pr.head.ref}/${filename}`;
}

run();
