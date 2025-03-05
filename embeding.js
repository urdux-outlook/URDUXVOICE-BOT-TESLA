const initPipeline = async () => {
    console.log('[LOG] Initializing the pipeline...');
    const { pipeline } = await import('@xenova/transformers');
    console.log('[LOG] Pipeline initialized successfully.');
    return pipeline;
};

const initPinecone = async () => {
    console.log('[LOG] Initializing Pinecone...');
    const { Pinecone } = require('@pinecone-database/pinecone');
    try {
        const pinecone = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY,
            environment: process.env.PINECONE_ENV
        });
        console.log('[LOG] Pinecone initialized successfully.');
        return pinecone;
    } catch (error) {
        console.error('[ERROR] Error initializing Pinecone:', error);
        throw error;
    }
};

const generatePromptEmbedding = async (prompt) => {
    console.log(`[LOG] Generating embedding for prompt: "${prompt}"`);
    try {
        const pipeline = await initPipeline();
        console.log('[LOG] Extractor pipeline ready.');
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[LOG] Feature extraction pipeline loaded.');
        const result = await extractor(prompt, { pooling: 'mean', normalize: true });
        console.log('[LOG] Embedding generated successfully.');
        return Array.from(result.data);
    } catch (error) {
        console.error('[ERROR] Error generating prompt embedding:', error);
        throw error;
    }
};

const retrieveRelevantDocuments = async (promptEmbedding, index) => {
    console.log('[LOG] Retrieving relevant documents...');
    try {
        console.log('[LOG] Querying Pinecone index...');
        const queryResponse = await index.query({
            vector: promptEmbedding,
            topK: 3,
            includeMetadata: true
        });
        console.log('[LOG] Query successful. Processing results...');
        const results = queryResponse.matches.map(match => ({
            score: match.score,
            documentId: match.metadata.documentId,
            content: match.metadata.content
        }));
        console.log('[LOG] Relevant documents retrieved successfully.');
        return results;
    } catch (error) {
        console.error('[ERROR] Error retrieving relevant documents:', error);
        throw error;
    }
};

module.exports = {
    initPinecone,
    generatePromptEmbedding,
    retrieveRelevantDocuments
};
