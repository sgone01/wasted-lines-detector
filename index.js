const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

async function run() {
    try {
        core.info("🚀 Wasted Lines Detector is starting...");

        const token = process.env.GITHUB_TOKEN || core.getInput('github_token');
        const aiApiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');

        if (!token) {
            core.setFailed("❌ Error: Missing GitHub Token!");
            return;
        }
        if (!aiApiKey) {
            core.setFailed("❌ Error: Missing Gemini AI API Key!");
            return;
        }

        const octokit = github.getOctokit(token);
        const { context } = github;
        const pr = context.payload.pull_request;

        if (!pr) {
            core.setFailed('❌ No pull request found.');
            return;
        }

        core.info(`🔍 PR Detected: #${pr.number} - Fetching changed files...`);

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        const comments = await analyzeFiles(files.data, octokit, context.repo, pr.head.ref, aiApiKey);

        if (comments.length > 0) {
            const commentBody = generateCommentBody(comments, context.repo, pr.head.ref);

            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: commentBody
            }).catch(error => {
                core.error(`❌ Failed to create comment: ${error.message}`);
            });
        } else {
            core.info("🎉 No issues detected!");
        }
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

async function analyzeFiles(files, octokit, repo, branch, aiApiKey) {
    let comments = [];

    for (const file of files) {
        if (!isSupportedFile(file.filename)) {
            core.info(`⏭ Skipping unsupported file: ${file.filename}`);
            continue;
        }

        core.info(`📄 Checking file: ${file.filename}`);
        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, branch);
        if (!content) {
            core.warning(`⚠️ Skipping ${file.filename} due to empty content.`);
            continue;
        }

        core.info(`🔍 Sending file to Gemini AI for analysis...`);
        const suggestion = await getSuggestionsFromGeminiAI(content, aiApiKey, file.filename);

        if (suggestion) {
            comments.push({
                path: file.filename,
                body: suggestion
            });
        }
    }

    return comments;
}

async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
    });

    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    return content;
}

async function getSuggestionsFromGeminiAI(content, apiKey, filename) {
    const language = getLanguageFromFilename(filename);
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        text: `Review the following ${language} code and suggest improvements in 200-250 words:\n\n${content}`
                    }
                ]
            }
        ]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (response.data && response.data.candidates) {
            return response.data.candidates[0].content.parts[0].text.trim();
        } else {
            core.warning(`⚠️ No valid response from Gemini AI for ${filename}`);
            return null;
        }
    } catch (error) {
        core.error(`❌ Gemini AI request failed: ${error.message}`);
        return null;
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

function generateCommentBody(comments, repo, ref) {
    const repoUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${ref}`;

    let commentBody = `### 🚀 Code Review Report \n\n`;
    comments.forEach(comment => {
        commentBody += `📄 **[${comment.path}](${repoUrl}/${comment.path})**\n`;
        commentBody += `\n**Suggestion:**\n`;
        commentBody += `\`\`\`\n${comment.body}\n\`\`\`\n\n`;
    });

    return commentBody;
}

function isSupportedFile(filename) {
    const supportedExtensions = ['.js', '.py', '.sh', '.rb', '.groovy'];
    return supportedExtensions.some(ext => filename.endsWith(ext));
}

run();
