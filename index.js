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

async function run() {
    try {
        const octokit = await getOctokitInstance();
        if (!octokit) return;

        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) return;

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        const comments = await analyzeFiles(files.data, octokit, context.repo, pr.head.ref);

        if (comments.length > 0) {
            await octokit.rest.pulls.createReview({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: pr.number,
                event: 'COMMENT',
                comments: comments.map(comment => {
                    const reviewComment = {
                        path: comment.filename,  // File path in PR
                        side: "RIGHT",  // Comment on the right side
                        line: comment.line,  // AI-suggested line number or fallback
                        body: comment.suggestion  // AI-generated suggestion
                    };

                    // Ensure `start_line` is only included when needed (for multi-line comments)
                    if (comment.start_line !== undefined) {
                        reviewComment.start_line = comment.start_line;
                    }

                    return reviewComment;
                }),
            });
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
                path: file.filename,
                body: formatGitHubReviewComment(file.filename, content, suggestion)
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
        comments: comments
    });
}

function formatGitHubReviewComment(filename, originalContent, suggestion) {
    return `### 💡 Code Review & Optimization for \`${filename}\`

---

#### **📌 Current Code**
\`\`\`${getLanguageFromFilename(filename).toLowerCase()}
${originalContent}
\`\`\`

#### **🚀 Optimized Code**
${suggestion}

---
🔹 **Complexity & Performance Analysis**  
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

run();
