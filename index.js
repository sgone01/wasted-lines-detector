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

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        await suggestInlineChanges(files.data, octokit, context.repo, pr, aiApiKey);
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

async function suggestInlineChanges(files, octokit, repo, pr, aiApiKey) {
    for (const file of files) {
        if (!isSupportedFile(file.filename)) continue;

        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, pr.head.ref);
        if (!content) continue;

        const suggestion = await getSuggestionsFromGeminiAI(content, aiApiKey, file.filename);
        if (suggestion) {
            await postInlineComment(octokit, repo.owner, repo.repo, pr.number, file, suggestion);
        }
    }
}

async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    return Buffer.from(response.data.content, 'base64').toString('utf-8');
}

async function getSuggestionsFromGeminiAI(content, apiKey, filename) {
    const language = getLanguageFromFilename(filename);
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

async function postInlineComment(octokit, owner, repo, prNumber, file, suggestion) {
    const firstLine = 1; // Posting at the start of the file (can be adjusted dynamically)

    await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        body: `### 🛠 Suggested Improvement\n\`\`\`${getLanguageFromFilename(file.filename).toLowerCase()}\n${suggestion}\n\`\`\``,
        commit_id: file.sha,
        path: file.filename,
        line: firstLine,
    });
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
