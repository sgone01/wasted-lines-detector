const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

async function run() {
    try {
        const token = process.env.GITHUB_TOKEN || core.getInput('github_token');
        const aiApiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');

        if (!token || !aiApiKey) {
            core.setFailed("❌ Missing required tokens.");
            return;
        }

        const octokit = github.getOctokit(token);
        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) return;

        const latestCommitSHA = pr.head.sha; // ✅ Get the latest commit SHA

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        const fileSuggestions = await analyzeFiles(files.data, octokit, context.repo, pr, aiApiKey);

        if (Object.keys(fileSuggestions).length > 0) {
            await postInlineComments(octokit, context.repo, pr, latestCommitSHA, fileSuggestions);
        }
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
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
            fileSuggestions[file.filename] = suggestions;
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

async function postInlineComments(octokit, repo, pr, commitSHA, fileSuggestions) {
    for (const [filename, suggestions] of Object.entries(fileSuggestions)) {
        for (const suggestion of suggestions) {
            try {
                await octokit.rest.pulls.createReviewComment({
                    owner: repo.owner,
                    repo: repo.repo,
                    pull_number: pr.number,
                    commit_id: commitSHA, // ✅ Attach to the latest commit
                    path: filename,
                    side: "RIGHT",
                    line: suggestion.line, // ✅ Correctly attach to the specific line
                    body: `**Issue:** ${suggestion.issue}\n\n**Suggested Fix:**\n\`\`\`${getLanguageFromFilename(filename).toLowerCase()}\n${suggestion.suggestedFix}\n\`\`\``
                });
            } catch (error) {
                console.error(`⚠️ Failed to comment on ${filename} (Line ${suggestion.line}): ${error.message}`);
            }
        }
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

run();
