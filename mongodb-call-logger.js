const mongoose = require('mongoose');
const fs = require('fs');
const { google } = require('googleapis');
const winston = require('winston');
const CallLog = require("./models/callLog")
const Appointment = require("./models/appointmentModel")
// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// MongoDB Connection URI
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://urduxvoicebot:urduxvoicebot@cluster0.c6tjb.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// MongoDB Connection with logging
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  logger.info('MongoDB connected successfully');
})
.catch(err => {
  logger.error('MongoDB connection error:', { error: err.message, stack: err.stack });
});
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);


function parseAppointmentDetails(llmResponse) {
  logger.debug('Attempting to parse appointment details', { 
    responseLength: llmResponse ? llmResponse.length : 0 
  });

  try {
    // Input validation
    if (!llmResponse || typeof llmResponse !== 'string') {
      logger.warn('Invalid input to parseAppointmentDetails', { 
        type: typeof llmResponse 
      });
      return null;
    }

    const patterns = {
      name: /Name:\s*([^\n]*)/,
      phone: /Phone:\s*([^\n]*)/,
      date: /Date:\s*([^\n]*)/,
      time: /Time:\s*([^\n]*)/,
      agent: /Agent:\s*([^\n]*)/,
      email: /Email:\s*([^\n]*)/
    };

    // Perform all regex matches
    const matches = {
      name: llmResponse.match(patterns.name),
      phone: llmResponse.match(patterns.phone),
      date: llmResponse.match(patterns.date),
      time: llmResponse.match(patterns.time),
      agent: llmResponse.match(patterns.agent),
      email: llmResponse.match(patterns.email)
    };

    // Log which patterns matched and which didn't
    logger.debug('Pattern matching results', {
      matches: Object.entries(matches).reduce((acc, [key, value]) => {
        acc[key] = !!value;
        return acc;
      }, {})
    });

    // Check if all patterns matched
    const allMatched = Object.values(matches).every(match => match !== null);

    if (allMatched) {
      const details = {
        customerName: matches.name[1].trim(),
        phoneNumber: matches.phone[1].trim(),
        email: matches.email[1].trim(),
        appointmentDateTime: `${matches.date[1].trim()} ${matches.time[1].trim()}`,
        service: matches.agent[1].trim(),
        status: 'scheduled'
      };

      logger.info('Successfully parsed appointment details', { 
        customerName: details.customerName,
        appointmentDateTime: details.appointmentDateTime
      });

      return details;
    } else {
      const missingFields = Object.entries(matches)
        .filter(([_, value]) => value === null)
        .map(([key]) => key);

      logger.warn('Missing required fields in appointment details', { 
        missingFields 
      });
      return null;
    }
  } catch (error) {
    logger.error('Error parsing appointment details:', {
      error: error.message,
      stack: error.stack,
      inputSample: llmResponse ? llmResponse.substring(0, 100) + '...' : 'null'
    });
    return null;
  }
}
// Google Calendar Service
class GoogleCalendarService {
  constructor() {
    this.auth = null;
    this.calendar = null;
    logger.info('GoogleCalendarService instance created');
  }

  async initialize() {
    try {
      logger.debug('Initializing Google Calendar service');
      const credentials = JSON.parse(fs.readFileSync('credentials.json'));
      const { client_id, client_secret, redirect_uris } = credentials.web;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

      const token = fs.readFileSync('token.json');
      oAuth2Client.setCredentials(JSON.parse(token));
      this.auth = oAuth2Client;
      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
      logger.info('Google Calendar service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Google Calendar service:', {
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  async createCalendarEvent(appointmentDetails) {
    logger.debug('Creating calendar event', { 
      appointmentDetails,
      calendarInitialized: !!this.calendar 
    });

    try {
      if (!this.calendar) {
        logger.warn('Calendar service not initialized, attempting to initialize');
        await this.initialize();
        if (!this.calendar) {
          logger.error('Calendar service initialization failed');
          return null;
        }
      }

      // Parse the appointment date string
      const appointmentDate = new Date(appointmentDetails.appointmentDateTime);
      if (isNaN(appointmentDate.getTime())) {
        logger.error('Invalid appointment date format', { 
          appointmentDateTime: appointmentDetails.appointmentDateTime 
        });
        return null;
      }

      // Create end time (1 hour after start)
      const endTime = new Date(appointmentDate.getTime() + 60 * 60 * 1000);

      // Create the event object
      const event = {
        summary: `Legal Consultation: ${appointmentDetails.customerName}`,
        description: `Service: ${appointmentDetails.service}\nPhone: ${appointmentDetails.phoneNumber}\nEmail: ${appointmentDetails.email}`,
        start: {
          dateTime: appointmentDate.toISOString(),
          timeZone: 'UTC'
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'UTC'
        },
        attendees: [
          { email: appointmentDetails.email }
        ],
        reminders: {
          useDefault: true,  // Use default reminders
        }
      };

      logger.debug('Attempting to insert calendar event', { 
        eventSummary: event.summary,
        startTime: event.start.dateTime 
      });

      const response = await this.calendar.events.insert({
        calendarId: 'primary',
        resource: event,
        sendUpdates: 'all'
      });

      logger.info('Calendar event created successfully', { 
        eventId: response.data.id,
        customerName: appointmentDetails.customerName,
        startTime: appointmentDate.toISOString()
      });

      return response.data.id;
    } catch (error) {
      logger.error('Error creating calendar event:', {
        error: error.message,
        stack: error.stack,
        appointmentDetails
      });
      return null;
    }
  }
}

const calendarService = new GoogleCalendarService();

// Save Appointment Function
async function saveAppointment(appointmentDetails) {
  logger.debug('Saving appointment', { appointmentDetails });
  try {
    let googleCalendarEventId = null;
    
    try {
      googleCalendarEventId = await calendarService.createCalendarEvent(appointmentDetails);
    } catch (calendarError) {
      logger.warn('Failed to create calendar event:', {
        error: calendarError.message,
        appointmentDetails
      });
    }

    const appointment = new Appointment({
      ...appointmentDetails,
      googleCalendarEventId
    });

    const savedAppointment = await appointment.save();

    logger.info('Appointment saved successfully', { 
      appointmentId: savedAppointment._id,
      customerName: appointmentDetails.customerName
    });
    return savedAppointment;
  } catch (error) {
    logger.error('Error saving appointment:', {
      error: error.message,
      stack: error.stack,
      appointmentDetails
    });
    throw error;
  }
}

async function saveCallLog(callData, conversationHistory) {
  try {
    // Validate and sanitize duration
    console.log("call history",conversationHistory)
    const sanitizedDuration = isNaN(callData.duration) ? 0 : Math.max(0, Number(callData.duration));
    
    // Get additional call details from Twilio
    let twilioCallDetails;
    try {
      twilioCallDetails = await twilioClient.calls(callData.sid).fetch();
    } catch (err) {
      console.warn('Could not fetch Twilio call details:', err);
      twilioCallDetails = {};
    }
    
    // Merge Twilio data with local data
    const update = {
      $set: {
        callSid: callData.sid,
        from: callData.from || twilioCallDetails.from || '',
        to: callData.to || twilioCallDetails.to || '',
        duration: sanitizedDuration || twilioCallDetails.duration || 0,
        startTime: callData.startTime || twilioCallDetails.startTime || new Date(),
        endTime: callData.endTime || twilioCallDetails.endTime || new Date(),
        status: callData.status || twilioCallDetails.status || 'completed',
        direction: callData.direction || twilioCallDetails.direction || 'inbound',
        recordingUrl: callData.recordingUrl || twilioCallDetails.recordingUrl || null,
        price: callData.price || twilioCallDetails.price || 0,
        priceUnit: callData.priceUnit || twilioCallDetails.priceUnit || 'USD',
        conversation: (conversationHistory || []).map(msg => ({
          role: msg.role || 'unknown',
          content: msg.content || '',
          timestamp: new Date()
        })),
        metadata: {
          customerName: callData.customerName || null,
          requestedService: callData.requestedService || null,
          appointmentDateTime: callData.appointmentDateTime || null,
          transferTarget: callData.transferTarget || null
        }
      }
    };

    const callLog = await CallLog.findOneAndUpdate(
      { callSid: callData.sid },
      update,
      { 
        upsert: true, 
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true 
      }
    );

    console.log('Call log saved/updated successfully:', callLog);
    return callLog;
  } catch (error) {
    console.error('Error saving call log:', error);
    throw error;
  }
}

async function getCallLogs(filter = {}, options = {}) {
  try {
    const {
      startDate,
      endDate,
      status,
      limit = 100,
      page = 1
    } = options;

    // Prepare Twilio filter
    const twilioFilter = {};
    if (startDate) twilioFilter.startTime = { $gte: new Date(startDate).toISOString() };
    if (endDate) twilioFilter.endTime = { $lte: new Date(endDate).toISOString() };
    if (status) twilioFilter.status = status;

    // Get calls from Twilio
    const twilioLogs = await twilioClient.calls.list({
      ...twilioFilter,
      limit: limit
    });

    // Get corresponding logs from MongoDB
    const callSids = twilioLogs.map(call => call.sid);
    const mongoLogs = await CallLog.find({
      callSid: { $in: callSids },
      ...filter
    }).sort({ startTime: -1 });

    // Merge Twilio and MongoDB data
    const mergedLogs = twilioLogs.map(twilioCall => {
      const mongoLog = mongoLogs.find(log => log.callSid === twilioCall.sid);
      return {
        callSid: twilioCall.sid,
        from: twilioCall.from,
        to: twilioCall.to,
        duration: twilioCall.duration,
        status: twilioCall.status,
        direction: twilioCall.direction,
        startTime: twilioCall.startTime,
        endTime: twilioCall.endTime,
        price: twilioCall.price,
        priceUnit: twilioCall.priceUnit,
        recordingUrl: twilioCall.recordingUrl,
        // Include MongoDB specific data if available
        conversation: mongoLog?.conversation || [],
        metadata: mongoLog?.metadata || {},
        // Add any additional Twilio fields you need
        answeredBy: twilioCall.answeredBy,
        apiVersion: twilioCall.apiVersion,
        forwardedFrom: twilioCall.forwardedFrom,
        groupSid: twilioCall.groupSid,
        callerName: twilioCall.callerName,
        uri: twilioCall.uri
      };
    });

    return {
      calls: mergedLogs,
      totalCount: twilioLogs.length,
      page: page,
      limit: limit
    };
  } catch (error) {
    console.error('Error retrieving call logs:', error);
    throw error;
  }
}

// Function to get a single call log by SID
async function getCallLogBySid(callSid) {
  try {
    // Get call details from Twilio
    const twilioCall = await twilioClient.calls(callSid).fetch();
    
    // Get corresponding MongoDB log
    const mongoLog = await CallLog.findOne({ callSid });

    // Merge the data
    return {
      callSid: twilioCall.sid,
      from: twilioCall.from,
      to: twilioCall.to,
      duration: twilioCall.duration,
      status: twilioCall.status,
      direction: twilioCall.direction,
      startTime: twilioCall.startTime,
      endTime: twilioCall.endTime,
      price: twilioCall.price,
      priceUnit: twilioCall.priceUnit,
      recordingUrl: twilioCall.recordingUrl,
      // Include MongoDB specific data if available
      conversation: mongoLog?.conversation || [],
      metadata: mongoLog?.metadata || {},
      // Additional Twilio fields
      answeredBy: twilioCall.answeredBy,
      apiVersion: twilioCall.apiVersion,
      forwardedFrom: twilioCall.forwardedFrom,
      groupSid: twilioCall.groupSid,
      callerName: twilioCall.callerName,
      uri: twilioCall.uri
    };
  } catch (error) {
    console.error('Error retrieving call log by SID:', error);
    throw error;
  }
}

async function getAppointments(filter = {}) {
  logger.debug('Retrieving appointments', { filter });
  try {
    const appointments = await Appointment.find(filter)
      .sort({ appointmentDateTime: 1 });
    
    logger.info('Appointments retrieved successfully', { 
      count: appointments.length 
    });
    return appointments;
  } catch (error) {
    logger.error('Error retrieving appointments:', {
      error: error.message,
      stack: error.stack,
      filter
    });
    throw error;
  }
}

async function updateAppointmentStatus(appointmentId, status) {
  logger.debug('Updating appointment status', { appointmentId, status });
  try {
    const updated = await Appointment.findByIdAndUpdate(
      appointmentId,
      { status },
      { new: true }
    );
    
    logger.info('Appointment status updated successfully', {
      appointmentId,
      status,
      customerName: updated.customerName
    });
    return updated;
  } catch (error) {
    logger.error('Error updating appointment status:', {
      error: error.message,
      stack: error.stack,
      appointmentId,
      status
    });
    throw error;
  }
}

module.exports = {
  CallLog,
  Appointment,
  saveCallLog,
  getCallLogs,
  saveAppointment,
  getAppointments,
  updateAppointmentStatus,
  parseAppointmentDetails,
  GoogleCalendarService,
  logger
};