const mongoose = require('mongoose');

// Define the schema for CallLog
const callLogSchema = new mongoose.Schema({
  callSid: {
    type: String,
    required: true,
    unique: true
  },
  from: String, // The phone number from which the call originated
  to: String,   // The phone number to which the call was made
  duration: Number,
  startTime: Date,
  endTime: Date,
  status: String,
  direction: String,
  recordingUrl: String,
  price: Number,
  priceUnit: String,
  transferredTo: String,
  conversation: [{
    role: String,
    content: String,
    timestamp: Date
  }],
  metadata: {
    customerName: String,
    requestedService: String,
    appointmentDateTime: Date,
    transferTarget: String
  },
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  }
});

// Create and export the CallLog model
const CallLog = mongoose.model('CallLog', callLogSchema);

module.exports = CallLog;
