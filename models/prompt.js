const mongoose = require('mongoose');

const promptSchema = new mongoose.Schema({
  prompt: {
    type: String,
    required: true
  }
}, { timestamps: true });

const Prompt = mongoose.model('Prompt', promptSchema);

module.exports = Prompt;