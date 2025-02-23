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

        const auth = createAppAuth({ appId, privateKey });
        const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

        const { data: installations } = await appOctokit.rest.apps.listInstallations();
        if (!installations.length) throw new Error("❌ No installations found.");

        const installationId = installations[0].id;
        const installationAuth = await auth({ type: "installation", installationId });

        return new Octokit({ auth: installationAuth.token });
    } catch (error) {
        core.setFailed(`❌ Failed to authenticate GitHub App. Error: ${error.message}`);
    }
}

function getDiffPosition(patch, lineNumber) {
    if (!patch) return null;
    const lines = patch.split('\n');
    let diffPosition = 0;
    let currentLine = 0;

    for (const line of lines) {
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+,\d+ \+(\d+),(\d+) @@/);
            if (match) {
                currentLine = parseInt(match[1], 10);
            }
        } else if (!line.startsWith('-')) {
            diffPosition++;
            if (currentLine === lineNumber) {
                return diffPosition;
            }
            currentLine++;
        }
    }
    return null;
}

async function analyzeFiles(files, octokit, repo, branch) {
    let comments = [];

    for (const file of files) {
        if (!isSupportedFile(file.filename)) continue;

        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, branch);
        if (!content) continue;

        const suggestion = await getSuggestionsFromGeminiAI(content, file.filename);

        console.log(`📌 AI Suggestion for ${file.filename}:`, suggestion);

        if (!suggestion) {
            console.warn(`⚠️ No suggestion received for ${file.filename}. Skipping.`);
            continue;
        }

        const firstLineNumber = content.split("\n").findIndex(line => line.trim() !== "") + 1;

        comments.push({
            path: file.filename,
            line: firstLineNumber,
            body: formatGitHubReviewComment(file.filename, content, suggestion)
        });
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
        contents: [{
            parts: [{
                text: `Analyze this ${language} code. Provide:
1️⃣ Optimized version.
2️⃣ Time complexity.
3️⃣ Execution time.

Limit response to 10 words only.

Code:
\`\`\`${language.toLowerCase()}
${content}
\`\`\`
`
            }]
        }]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, { headers: { 'Content-Type': 'application/json' } });

        console.log("🔍 AI Response:", JSON.stringify(response.data, null, 2)); // Debug Log

        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text.trim() || null;
    } catch (error) {
        console.error("❌ AI Request Failed:", error);
        return null;
    }
}

async function postReviewComments(octokit, comments, repo, prNumber) {
    if (!comments || comments.length === 0) {
        console.log("No comments to post.");
        return;
    }

    try {
        const { data: pullRequestDiff } = await octokit.rest.pulls.listFiles({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber
        });

        const formattedComments = comments
            .map(comment => {
                const file = pullRequestDiff.find(f => f.filename === comment.path);
                if (!file) {
                    console.error(`File ${comment.path} not found in PR.`);
                    return null;
                }

                const position = getDiffPosition(file.patch, comment.line);
                if (position === null) {
                    console.error(`Could not determine diff position for ${comment.path}:${comment.line}`);
                    return null;
                }

                return {
                    path: comment.path,
                    position,
                    body: comment.body
                };
            })
            .filter(comment => comment !== null);

        if (formattedComments.length === 0) {
            console.log("No valid review comments to post.");
            return;
        }

        await octokit.rest.pulls.createReview({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber,
            event: "COMMENT",
            comments: formattedComments
        });

        console.log("Review comments posted successfully.");
    } catch (error) {
        console.error("Error posting review comments:", error);
    }
}

function formatGitHubReviewComment(filename, originalContent, suggestion) {
    if (!suggestion || suggestion.trim() === "") {
        console.error(`❌ AI Suggestion is empty for ${filename}`);
        return `### 💡 Code Review for \`${filename}\`\n\n❌ AI Suggestion failed.`;
    }

    const [optimizedCode, complexity] = suggestion.split("\n").map(line => line.trim());

    if (!optimizedCode || !complexity) {
        console.error(`❌ Failed to parse AI response for ${filename}:`, suggestion);
        return `### 💡 Code Review for \`${filename}\`\n\n❌ AI Suggestion format is incorrect.`;
    }

    return `### 💡 Code Review & Optimization for \`${filename}\`

---

#### **📌 Current Code**
\`\`\`${getLanguageFromFilename(filename).toLowerCase()}
${originalContent}
\`\`\`

#### **🚀 Suggested Fix**
\`\`\`${getLanguageFromFilename(filename).toLowerCase()}
${optimizedCode}
\`\`\`

🔹 **Complexity Analysis:** ${complexity}  

_Generated by AI for better efficiency._
`;
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

async function run() {
    try {
        const octokit = await getOctokitInstance();
        const context = github.context;
        const { owner, repo } = context.repo;
        const prNumber = context.payload.pull_request.number;

        const { data: files } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber });
        const comments = await analyzeFiles(files, octokit, { owner, repo }, context.payload.pull_request.head.ref);
        await postReviewComments(octokit, comments, { owner, repo }, prNumber);
    } catch (error) {
        core.setFailed(`❌ Action failed: ${error.message}`);
    }
}

run();