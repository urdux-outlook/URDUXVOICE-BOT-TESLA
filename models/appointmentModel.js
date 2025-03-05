const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
    _id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    callSid: {
        type: String
    },
    customerName: {
        type: String,
        default: 'Not Known'
    },
    phoneNumber: {
        type: String,
        required: true
    },
    appointmentDateTime: {
        type: Date,
        required: true
    },
    service: {
        type: String,
        default: 'Not Known'
    },
    status: {
        type: String,
        enum: ['scheduled', 'completed', 'cancelled', 'pending'],
        default: 'pending'
    },
    email: {
        type: String,  // Add email field
        default: 'Not Known'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastModified: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Appointment', appointmentSchema);
