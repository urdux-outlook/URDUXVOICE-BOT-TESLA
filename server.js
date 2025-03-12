const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const moment = require('moment-timezone');
const express = require("express");
const bodyParser = require('body-parser');
const cors = require("cors")
dotenv.config();

// const { generateEmbedding, queryPinecone } = require('./pinecone');
const app = express();

let isAppointmentSaved = false;
// Middleware
app.use(cors({
  origin: 'http://localhost:3001', // Allow requests from the frontend
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allowed HTTP methods
  credentials: true // Allow credentials (if needed)
}));
app.use(bodyParser.json());
const mongoose = require('mongoose');
const Groq = require("groq-sdk")
const { CallLog, saveCallLog, getCallLogs , parseAppointmentDetails, saveAppointment } = require("./mongodb-call-logger")
const client = new Groq({ apiKey: "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" });
const activeCalls = new Map();
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest);
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const HTTP_SERVER_PORT = 8080;
const WebSocket = require('ws');
let streamSid = '';

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

const models = ['athena', 'helios'];

// File path where the last selected model will be stored
const filePath = './lastSelectedModel.txt';

// Function to read the last selected model from the file
const readLastSelectedModel = () => {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();  // Read the file and remove extra spaces/newlines
    }
  } catch (error) {
    console.error('Error reading the file:', error);
  }
  return null;
};

// Check if the file exists and create it if not
const createFileIfNotExists = () => {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf-8');  // Create an empty file if it doesn't exist
    }
  } catch (error) {
    console.error('Error creating the file:', error);
  }
};

// Create the file if it doesn't exist
createFileIfNotExists();

// Get the last selected model
let lastSelectedModel = readLastSelectedModel();

// Determine the selected model
let selectedModel;
if (lastSelectedModel) {
  // Alternate model if one has already been selected
  selectedModel = lastSelectedModel === 'athena' ? 'helios' : 'athena';
} else {
  // If no model has been selected before, randomly select a model
  selectedModel = models[Math.floor(Math.random() * models.length)];
}

// Set the name based on the selected model
const selectedName = selectedModel === 'athena' ? 'Sarah' : 'John';

// Update the WebSocket URL dynamically based on selected model
const deepgramTTSWebsocketURL = `wss://api.deepgram.com/v1/speak?model=aura-athena-en&encoding=mulaw&sample_rate=8000&container=none&voice=british&speed=0.9&pitch=2`;

// Write the selected model to the file for the next selection
fs.writeFileSync(filePath, selectedModel, 'utf-8');

// Re-read the file to get the updated data
lastSelectedModel = readLastSelectedModel();

// Example usage
console.log(`Selected Model: ${lastSelectedModel}`);  // 'athena' or 'helios'
console.log(`Selected Name: ${selectedName}`);   // 'Sarah' or 'John'
console.log(`WebSocket URL: ${deepgramTTSWebsocketURL}`);  // WebSocket URL with selected model


const SERVICES = {
  COMMERCIAL_AGENT: 'Commercial Lease Contract Agent',
  QUERIES_ASSISTANT: 'Queries Law Assistant',
  LAWYER_APPOINTMENT: 'Lawyer Appointment'
};

const TRANSFER_NUMBERS = {
  COMMERCIAL_AGENT: '+923081509198',  
  QUERIES_ASSISTANT: '+923081509198',
  EMERGENCY: '+923081509198'         
};

let sttStartTime = 0;
let ttsStartTime = 0;
let utteranceStartTime = 0;
let transcriptionTimes = [];
let ttsTimes = [];
// Performance Timings
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// Convert milliseconds to seconds with 2 decimal places
function msToSeconds(ms) {
  return (ms / 1000).toFixed(2);
}

const CONVERSATION_STATES = {
  GREETING: 'GREETING',
  COLLECTING_PURPOSE: 'COLLECTING_PURPOSE',
  COLLECTING_TRANSFER_INFO: 'COLLECTING_TRANSFER_INFO',
  COLLECTING_APPOINTMENT_INFO: 'COLLECTING_APPOINTMENT_INFO',
  COLLECTING_NAME: 'COLLECTING_NAME',
  COLLECTING_DATE: 'COLLECTING_DATE',
  COLLECTING_TIME: 'COLLECTING_TIME',
  CONFIRMING_DETAILS: 'CONFIRMING_DETAILS',
  FAREWELL: 'FAREWELL'
};

// Enhanced Conversation Manager
class ConversationManager {
  constructor() {
    this.conversations = new Map();
  }
  createConversation(streamSid) {
    this.conversations.set(streamSid, {
      history: [],
      clientInfo: {
        name: null,
        requestedService: null,
        appointmentDateTime: null,
        callTransferRequested: false,
        transferTarget: null
      },
      state: CONVERSATION_STATES.GREETING,
      lastResponse: null,
      verified: false
    });
  }

  addMessage(streamSid, role, content) {
    if (!this.conversations.has(streamSid)) {
      this.createConversation(streamSid);
    }
    const conversation = this.conversations.get(streamSid);
    conversation.history.push({ role, content });
    return conversation;
  }

  updateClientInfo(streamSid, info) {
    if (!this.conversations.has(streamSid)) {
      this.createConversation(streamSid);
    }
    const conversation = this.conversations.get(streamSid);
    conversation.clientInfo = { ...conversation.clientInfo, ...info };
  }

  getConversation(streamSid) {
    return this.conversations.get(streamSid);
  }

  getHistory(streamSid) {
    return this.conversations.get(streamSid)?.history || [];
  }

  isWithinBusinessHours(dateTime) {
    const time = moment(dateTime).tz(BUSINESS_HOURS.timezone);
    const hour = time.hour();
    const dayOfWeek = time.day();
    return dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
  }
}

const conversationManager = new ConversationManager();

function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

dispatcher.onGet("/", function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Legal Receptionist Service Running');
});

dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});

// Logging utility
function serverLog(message, type = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = null;
    this.deepgramTTSWebsocket = null;
    this.callSid = null;
    this.hasSeenMedia = false;
    this.isTerminating = false;
    this.keepAliveInterval = null;
    this.initialGreetingSent = false; // Add this flag
    if (this.callSid) {
      const callInfo = {
          phoneNumber: connection.remoteAddress,
          status: 'in-progress',
          startTime: Date.now(),
          callSid: this.callSid
      };
    this.callStartTime = new Date();
    this.callData = {
      startTime: new Date(),
      status: 'in-progress'
    };
    this.logSaved = false;
      activeCalls.set(this.callSid, callInfo);
      serverLog(`New call started: ${this.callSid}`, 'info');
      serverLog(`Active calls count: ${activeCalls.size}`, 'debug');
  }
    
    this.initialize();
  }

  async initialize() {
    try {
      this.deepgram = setupDeepgram(this);
      this.deepgramTTSWebsocket = this.setupDeepgramWebsocket();
      
      // Increase keep-alive interval to reduce overhead
      this.keepAliveInterval = setInterval(() => {
        if (this.deepgram) {
          this.deepgram.keepAlive();
        }
      }, 15 * 1000);  // Increase from 10s to 15s

      this.connection.on("message", this.processMessage.bind(this));
      this.connection.on("close", this.close.bind(this));
    } catch (error) {
      console.error('Error initializing MediaStream:', error);
      this.cleanup();
    }
  }

  setupDeepgramWebsocket() {
    const options = {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    };
    const ws = new WebSocket(deepgramTTSWebsocketURL, options);

    ws.on('open', () => {
      console.log('deepgram TTS: Connected');
      
      // Send initial greeting when WebSocket is ready
      if (!this.initialGreetingSent && this.callSid) {
        const greetingMessage = getRandomPhrase([
          "Thank you for calling Legal Firm Reception,. . . , how can I help you today?",
          "Welcome to Legal Firm Reception, how can I help you today?",
          "You've reached Legal Firm Reception,. . . , how can I help you today?",
          "Thank you for calling Legal Firm Reception, how can I help you today?"
        ]);
        
        speaking = true;
        ws.send(JSON.stringify({ 
          'type': 'Speak', 
          'text': greetingMessage 
        }));
        ws.send(JSON.stringify({ 'type': 'Flush' }));
        
        // Update conversation state
        conversationManager.updateClientInfo(streamSid, { state: 'AWAITING_INITIAL_RESPONSE' });
        conversationManager.addMessage(streamSid, 'assistant', greetingMessage);
        
        this.initialGreetingSent = true;
      }
    });

    ws.on('message', (data) => {
      if (speaking) {
        try {
          let json = JSON.parse(data.toString());
          console.log('deepgram TTS: ', data.toString());
          return;
        } catch (e) {
          // Ignore
        }
        if (firstByte) {
          const ttsEndTime = Date.now();
          const ttsDuration = ttsEndTime - ttsStartTime;
          ttsTimes.push(ttsDuration);
          
          console.log('\n=== Deepgram TTS Timing ===');
          console.log('Time to First Byte:', msToSeconds(ttsDuration), 'seconds');
          console.log('Average TTS Response Time:', msToSeconds(calculateAverage(ttsTimes)), 'seconds');
          firstByte = false;
          
          if (send_first_sentence_input_time) {
            const sentenceTTSDuration = ttsEndTime - send_first_sentence_input_time;
            console.log('Time from sentence end to TTS:', msToSeconds(sentenceTTSDuration), 'seconds');
          }
        }
        const payload = data.toString('base64');
        const message = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload,
          },
        };
        this.connection.sendUTF(JSON.stringify(message));
      }
    });

    ws.on('close', () => {
      console.log('deepgram TTS: Disconnected');
      printTimingStats();
    });

    ws.on('error', (err) => {
      console.error('deepgram TTS: error:', err);
    });

    return ws;
  }
async processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      
      if (data.event === "start") {
        console.log("twilio: Start event received: ", data);
        this.callSid = data.start.callSid;
        await this.handleCallStart(data);
        // this.callData = {
        //   ...this.callData,
        //   sid: this.callSid,
        //   from: data.start.from,
        //   to: data.start.to,
        //   direction: 'inbound'
        // };
        llmStart = Date.now();
        promptLLM(this, "START_CONVERSATION");
      }
      
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received: ", data);
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          streamSid = data.streamSid;
        }
        if (data.media.track == "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          if (this.deepgram && !this.isTerminating) {
            this.deepgram.send(rawAudio);
          }
        }
      }
    }
  }


  async handleCallStart(data) {
    this.callSid = data.start.callSid;
    this.callData = {
      ...this.callData,
      sid: this.callSid,
      from: data.start.from,
      to: data.start.to,
      direction: 'inbound'
    };
    console.log('Call start data initialized:', this.callData);
  }

  async logCallData() {
    // Only proceed if we haven't already saved this call's log
    if (this.logSaved || !this.callSid) {
      console.log('Skipping call log: already saved or no callSid');
      return;
    }

    console.log('Starting call logging process...');
    try {
      // Wait for any pending conversations to be processed
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Fetch conversation with retry
      let conversation = null;
      let retryCount = 0;
      while (!conversation && retryCount < 3) {
        conversation = conversationManager.getConversation(streamSid);
        if (!conversation) {
          await new Promise(resolve => setTimeout(resolve, 500));
          retryCount++;
        }
      }

      // Log conversation state for debugging
      console.log("Conversation state:", conversation?.state || 'No state available');
      console.log("Conversation history:", conversation?.history || 'No history available');

      // Get Twilio call details
      let twilioCallDetails;
      try {
        twilioCallDetails = await twilioClient.calls(this.callSid).fetch();
        console.log('Twilio call details retrieved:', twilioCallDetails);
      } catch (err) {
        console.warn('Failed to fetch Twilio call details:', err.message);
        twilioCallDetails = {};
      }

      // Calculate call duration
      const callDuration = Math.ceil((new Date() - this.callStartTime) / 1000);

      // Prepare call data
      const callData = {
        sid: this.callSid,
        from: twilioCallDetails.from || this.callData.from,
        to: twilioCallDetails.to || this.callData.to,
        duration: callDuration,
        startTime: this.callStartTime,
        endTime: new Date(),
        status: 'completed',
        direction: twilioCallDetails.direction || 'inbound',
        price: twilioCallDetails.price || null,
        priceUnit: twilioCallDetails.priceUnit || null,
        recordingUrl: twilioCallDetails.recordingUrl || null,
        customerName: conversation?.clientInfo?.name || null,
        requestedService: conversation?.clientInfo?.requestedService || null,
        appointmentDateTime: conversation?.clientInfo?.appointmentDateTime || null,
        transferTarget: conversation?.clientInfo?.transferTarget || null,
        conversationHistory: conversation?.history || []
      };

      // Save call log
      const savedLog = await saveCallLog(callData, conversation?.history || []);
      console.log('Call log saved successfully:', savedLog);
      this.logSaved = true;

    } catch (error) {
      console.error('Error in call logging process:', error);
      throw error;
    }
  }

    async cleanup() {
      try {
       
        this.isTerminating = true;
        await this.logCallData();
        // Print final timing statistics
        printTimingStats();
        
        // Clear keep-alive interval
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }

        // Close Deepgram connection
        if (this.deepgram) {
          await this.deepgram.finish();
          this.deepgram = null;
        }

        // Close TTS websocket
        if (this.deepgramTTSWebsocket) {
          this.deepgramTTSWebsocket.close();
          this.deepgramTTSWebsocket = null;
        }

        // Reset conversation state
        speaking = false;
        streamSid = '';

        console.log('MediaStream cleanup completed');
      } catch (error) {
        console.error('Error during MediaStream cleanup:', error);
      }
    }

    async close() {
      console.log("twilio: Closed");
      
      await this.cleanup();
      
      // Clean up conversation manager
      if (streamSid) {
        conversationManager.conversations.delete(streamSid);
      }
    }
  }


const FAREWELL_PHRASES = [
  'goodbye', 'bye', 'thank you bye', 'thanks bye', 'have a nice day', 
  'that\'s all', 'that is all', 'no thanks', 'nothing else',
  'that\'s it', 'that will be all'
];


// Add this function to handle call termination
async function terminateCall(mediaStream) {
  console.log('\n=== Call Termination Initiated ===');
  
  if (!mediaStream.callSid) {
    console.error('Error: No callSid available for termination');
    return;
  }

  try {
    if (!mediaStream.isTerminating) {
      await twilioClient.calls(mediaStream.callSid)
        .update({
          status: 'completed'
        });

      await mediaStream.cleanup();
    }
    
    // Close the WebSocket connection
    mediaStream.connection.close();
    
    console.log('Call terminated successfully:', mediaStream.callSid);
  } catch (error) {
    console.error('Error during call termination:', error);
  }
}



// Enhanced promptLLM function to handle farewells
// Enhanced farewell handling function
async function handleFarewell(mediaStream, prompt) {
  console.log('\n=== Farewell Sequence Initiated ===');
  
  // Add the farewell exchange to conversation history
  conversationManager.addMessage(streamSid, 'user', prompt);
  
  const farewellMessage = "Thank you for contacting Legal Firm Reception. Have a great day!";
  conversationManager.addMessage(streamSid, 'assistant', farewellMessage);
  
  // Only send farewell message if not already terminating
  if (!mediaStream.isTerminating) {
    speaking = true;
    
    // Send farewell message through TTS
    if (mediaStream.deepgramTTSWebsocket) {
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 
        'type': 'Speak', 
        'text': farewellMessage 
      }));
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
    }
  }

  
  // Initiate termination sequence after 2 seconds
  setTimeout(() => {
    terminateCall(mediaStream);
  }, 3000);
}


// Function to randomly select a phrase from an array
function getRandomPhrase(phrases) {
  return phrases[Math.floor(Math.random() * phrases.length)];
}



const APPOINTMENT_MARKERS = {
  START: "APPOINTMENT_CONFIRMATION_START",
  END: "APPOINTMENT_CONFIRMATION_END"
};


function loadPrompt() {
  return new Promise((resolve, reject) => {
    fs.readFile('prompts.json', 'utf8', (err, data) => {
      if (err) {
        reject("Error loading prompt: " + err);
      } else {
        resolve(data);
      }
    });
  });
}
const validateappointment = (text) => {
  // Extract values using exact format from the appointment confirmation
  const customerNameMatch = text.match(/customerName:\s*([^\n]+)/);
  const phoneNumberMatch = text.match(/phoneNumber:\s*([^\n]+)/);
  const dateTimeMatch = text.match(/appointmentDateTime:\s*([^\n]+)/);
  const serviceMatch = text.match(/service:\s*([^\n]+)/);

  // Get the values or set to null if not found
  const customerName = customerNameMatch ? customerNameMatch[1].trim() : null;
  
  // Format phone number: remove spaces, ensure + prefix
  let phoneNumber = phoneNumberMatch ? phoneNumberMatch[1].trim().replace(/\s+/g, '') : null;
  if (phoneNumber) {
    // Remove any existing + to avoid double +
    phoneNumber = phoneNumber.replace(/^\+/, '');
    // Add + prefix if it doesn't exist
    phoneNumber = '+' + phoneNumber;
  }
  
  const appointmentDateTime = dateTimeMatch ? new Date(dateTimeMatch[1].trim()) : null;
  const service = serviceMatch ? serviceMatch[1].trim() : null;

  return {
    _id: new mongoose.Types.ObjectId(),
    customerName,
    phoneNumber,
    appointmentDateTime,
    service,
    email: 'alitajir32@gmail.com',
    status: 'scheduled'
  };
};

// Add these utility functions for date handling
function getCurrentYear() {
  return new Date().getFullYear();
}

function isValidAppointmentDate(dateTime) {
  const appointmentDate = moment(dateTime);
  const now = moment();
  
  // Ensure date is not in the past
  if (appointmentDate.isBefore(now, 'day')) {
    return false;
  }
  
  // Ensure year is current or next year only
  const appointmentYear = appointmentDate.year();
  const currentYear = getCurrentYear();
  if (appointmentYear !== currentYear && appointmentYear !== currentYear + 1) {
    return false;
  }
  
  return true;
}


async function promptLLM(mediaStream, prompt) {
  const messages = [];
  let state = conversationManager.getConversation(streamSid)?.state || 'GREETING';
  let firstToken = true;
  let responseText = '';
  let buffer = '';
  const CHUNK_THRESHOLD = 10;
  let isAppointmentConfirmation = false;
  let appointmentBuffer = '';


 // Handle farewells
 if (prompt !== "START_CONVERSATION" && isFarewell(prompt)) {
  await handleFarewell(mediaStream, prompt);
  return;
}

// Handle initial greeting
if (prompt === "START_CONVERSATION") {
  return;
}
const promptss = `You are a human receptionist named ${selectedName} at Legal Firm Reception in London. Your responses must be **very short, concise, and complete**, but they should feel **natural, engaging, and very professional**. Use **"ummm"** after commas and **"..."** (three dots and a space) for natural pauses. **Use breaks, pauses, and filler words frequently**... but keep responses **brief**.
CONTEXT:
You are an AI receptionist at Legal Firm Reception in London. You help new customers 'book appointments' with 'Commercial Lease Contract Agent' or 'Queries Law Assistant'... or you can transfer the call to these agents if requested by the new users.
BUSINESS RULES:
1. Operating hours: Monday-Friday, 9:00 AM - 5:00 PM...
2. Services offered:
   * Speak to Commercial Lease Contract Agent: transfer call to Commercial Lease Contract Agent
   * Speak to Queries Law Assistant: transfer call to Queries Law Assistant
   * Book an appointment with one of the Lawyers
3. Appointments must be scheduled within business hours only...
4. Do not transfer any call after or during appointment booking unless specifically asked by the user.
5. Clearly identify the transfer target based on user input: 'Commercial Lease Contract Agent' or 'Queries Law Assistant'...
CUSTOMER SERVICE CALL FLOW FOR BOOKING APPOINTMENT:
  1. When booking an appointment, ask ONLY these questions in sequence:

      "May I have your name, please... ,?"
      "Could I get your phone number, let me note it down...?"
      "What date and time, would work best for you?..please specify year..,month..,and day..,"
      "What date and time ummm, would work best for you?..please specify year..,month..,and day..,"
      "Which agent would you like to book an appointment with,'Commercial Lease Contract Agent'... or 'Queries Law Assistant'?"

  2. After collecting all details, ALWAYS summarize in this exact format:
  "Okay... let's see... hmmm... your details: Name is: [Name] ..., Phone number is: [spell digits: e.g., two zero three, nine one two, three four five] ..., Date selected: [Date] ... , Time is: [Time] ... , Agent is: [Agent]... , Is that right... ,?"
  3. If any corrections are needed, update only that specific detail and provide the full summary again in the same format.

**IMPORTANT**: If the user confirms the appointment details:
- Ensure that a response containing the
${APPOINTMENT_MARKERS.END}
marker is **always** included in the output.
- This will trigger the  condition to save the appointment asynchronously.

After confirmation, end with: "Do you have any other query... ,?"



APPOINTMENT CONFIRMATION FORMAT:
After collecting and confirming all appointment details casually, ALWAYS output them in this EXACT format:
Name: [full name] 
Phone: [phone number with spaces between each digit] 
Date: [YYYY-MM-DD] 
Time: [HH:mm in 24-hour format] 
Agent: [exact agent name: either "Commercial Lease Contract Agent" or "Queries Law Assistant"] 
${APPOINTMENT_MARKERS.END}


IMPORTANT DATE HANDLING:
- Always include the full year (${getCurrentYear()}) when confirming appointment dates
- Only allow appointments for current year (${getCurrentYear()}) or next year (${getCurrentYear() + 1})
- Format dates as YYYY-MM-DD HH:mm in 24-hour format
- If a customer requests a date without specifying the year, assume current year (${getCurrentYear()}) unless the date has passed, then use next year (${getCurrentYear() + 1})


CUSTOMER SERVICE CALL FLOW FOR CALL TRANSFER:
* Ask the user which agent to transfer the call to: 'Commercial Lease Contract Agent' or 'Queries Law Assistant'...
* Confirm from the user which agent to transfer the call to before transferring...
* **Before transferring**, say "Your call is being transferred... ,"
INTERACTION GUIDELINES:
* **Responses should be very short**, not exceeding 1-2 sentences...
* **Don't transfer the call** unless explicitly requested by the user...
* If the user says they want to talk to any agent, confirm if they wish to **transfer the call** or **book an appointment**...
* Ensure responses sound **natural** and **engaging**—with **human-like pauses**...
* For emergencies/arrests, provide a 24-hour helpline: 123456789...
RESPONSE STYLE GUIDELINES:
* Keep responses brief (1-2 sentences) while maintaining a warm, professional tone
* Insert natural pauses in these specific situations:
  - After greeting the caller: "Hello... how can I help you today?"
  - Never include "(laugh)", "(laughs)", "(pause)", "ha ha ha"
  - replace "(laugh)","(laughs)","(pause)", "*laughs*" with ". . . "
  - replace "(laugh)" with ". . . "
  - replace "(pause)" with ". . . "
  - replace "(laughs)" with  ". . . "
MAGICAL RESPONSE ENHANCEMENT:
* **More breaks and pauses**: Use "ummm," "okay then," "...", "just a moment," "let's see" naturally throughout the responses...
* **Frequent pauses** after keywords: "Okay... , let me check," "Alright...,", "Just a second...,", etc...
* Keep the responses **brief, magical, and warm**, with **human-like conversational breaks**...
* **Make pauses feel natural** by including phrases like **"just a moment," "let me see," "ummm,"** or even **"okay, alright"**...
* Responses should be **clear, brief, and to the point**, with **lots of natural breaks** and pauses...
Current conversation state: *\${conversationManager.getConversation(streamSid)?.state || 'GREETING'}*`;


// Replace your existing code with this:
const updatedPrompt = promptss.replace('${conversationManager.getConversation(streamSid)?.state || \'GREETING\'}', state);

messages.push({
  role: 'system',
  content: updatedPrompt
});
      //  

// const embedding = await generateEmbedding(prompt);
// console.log('Generated embedding:', embedding);



// const relevantDocuments = await queryPinecone(embedding);

//     // If relevant documents are found, add them to the LLM prompt
//     if (relevantDocuments.length > 0) {
//       messages.push({
//         role: 'assistant',
//         content: 'Here are some documents that might help with your query:'
//       });

//       relevantDocuments.forEach(doc => {
//         messages.push({
//           role: 'assistant',
//           content: `Document ID: ${doc.documentId}, Score: ${doc.score}\nContent: ${doc.content}`
//         });
//       });
//     } else {
//       // If no relevant documents, proceed with default behavior
//       messages.push({
//         role: 'assistant',
//         content: 'Sorry, I couldn’t find relevant documents, but I can still assist you.'
//       });
//     }
  // Add conversation history (last 5 messages for context)
  const history = conversationManager.getHistory(streamSid).slice(-15);
  messages.push(...history);

  // Handle transfer requests
  const conversation = conversationManager.getConversation(streamSid);
  if (conversation?.clientInfo?.callTransferRequested) {
    const transferMessage = `I'll connect you to ${conversation.clientInfo.transferTarget} right away. Please hold.`;
    
    messages.push({
      role: 'assistant',
      content: transferMessage
    });
    
    transferCall(mediaStream, conversation.clientInfo.transferTarget);
    return;
  }

  console.log('\n=== Claude Request ===');
  console.log('Prompt:', prompt);

  try {

    isAppointmentSaved = false; // Reset the flag
    speaking = true;
    messages.push({
      role: 'user',
      content: prompt
    });

    const stream = await client.chat.completions.create({
      model: 'llama3-8b-8192',
      max_tokens: 80,
      temperature: 0,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      stream: true
    });

    for await (const chunk of stream) {
      if (!speaking) break;

      if (firstToken) {
        console.log('\n>>> LLM Response Started <<<');
        console.log('Time to First Token:', Date.now() - llmStart, 'ms');
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
        firstToken = false;
      }

      const chunkText = chunk.choices[0]?.delta?.content;
      if (chunkText) {
        responseText += chunkText;
        buffer += chunkText;

        // If this appears to be an appointment confirmation
        if (responseText.includes(APPOINTMENT_MARKERS.END)) {
          // Only proceed if we haven't saved this appointment yet
          if (!isAppointmentSaved) {
            // Make a separate LLM call to extract appointment details
            const extractionMessages = [
              {
                role: 'system',
                content: `Extract appointment details from the conversation history and format them as follows:
                  customerName: Full name of the customer
                  phoneNumber: Phone number
                  appointmentDateTime: Date and time in YYYY-MM-DD HH:mm format
                  service: Either "Commercial Lease Contract Agent" or "Queries Law Assistant"
                  Make sure to extract the information as described in the format and donot provide any extra information
                  Only extract confirmed appointment details.`
              },
              ...history,
              {
                role: 'user',
                content: 'Please extract the appointment details from our conversation.'
              }
            ];
        
            console.log("extracting messages...", extractionMessages);
            const extractionResponse = await client.chat.completions.create({
              model: 'llama3-8b-8192',
              messages: extractionMessages,
              temperature: 0
            });
            console.log("extracting response....", extractionResponse);
        
            console.log("llm response ", extractionResponse.choices[0].message.content);
            const appointmentDetails = validateappointment(extractionResponse.choices[0].message.content);
            console.log("extracting details....", appointmentDetails);
            
            try {
              const appointment = {
                _id: appointmentDetails._id,
                customerName: appointmentDetails.customerName,
                phoneNumber: appointmentDetails.phoneNumber,
                appointmentDateTime: appointmentDetails.appointmentDateTime,
                service: appointmentDetails.service,
                email: 'alitajir32@gmail.com',
                status: 'scheduled',
                callSid: mediaStream.callSid
              };
            
              const savedAppointment = await saveAppointment(appointment, mediaStream.callSid);
              console.log('Appointment saved:', savedAppointment);
              
              // Mark appointment as saved
              isAppointmentSaved = true;
            
              conversationManager.updateClientInfo(streamSid, {
                name: appointmentDetails.customerName,
                appointmentDateTime: appointmentDetails.appointmentDateTime,
                requestedService: appointmentDetails.service
              });
            } catch (error) {
              console.error('Error processing appointment:', error);
            }
          } else {
            console.log('Appointment already saved, skipping duplicate save');
          }
        }
        
        // Handle text-to-speech
        if (buffer.length >= CHUNK_THRESHOLD || /[.!?]/.test(buffer)) {
          const cleanedBuffer = cleanResponseForTTS(buffer);
          if (cleanedBuffer.trim()) {
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 
              'type': 'Speak', 
              'text': cleanedBuffer 
            }));
          }
          buffer = '';
        }
      }
    }

    // Send remaining buffer
    if (buffer.length > 0) {
      const cleanedBuffer = cleanResponseForTTS(buffer);
      if (cleanedBuffer.trim()) {
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 
          'type': 'Speak', 
          'text': cleanedBuffer 
        }));
      }
    }
    // Send any remaining buffered text
    if (buffer.length > 0) {
      const cleanedBuffer = cleanResponseForTTS(buffer);
      if (cleanedBuffer.trim()) {
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 
          'type': 'Speak', 
          'text': cleanedBuffer 
        }));
      }
    }


    if (responseText.toLowerCase().includes('transfer_requested'))

    console.log('\n=== Complete Response ===');
    console.log(responseText);

    // Handle transfer detection in response
    if (responseText.toLowerCase().includes('transfer')) {
      const conversation = conversationManager.getConversation(streamSid);
      console.log('\n=== Transfer Attempt Detected ===');
      console.log('Conversation State:', conversation);
      
      let transferTarget = null;
      if (responseText.includes(SERVICES.COMMERCIAL_AGENT)) {
        transferTarget = SERVICES.COMMERCIAL_AGENT;
      } else if (responseText.includes(SERVICES.QUERIES_ASSISTANT)) {
        transferTarget = SERVICES.QUERIES_ASSISTANT;
      }
      
      if (transferTarget) {
        console.log('Initiating transfer to:', transferTarget);
        conversationManager.updateClientInfo(streamSid, {
          callTransferRequested: true,
          transferTarget: transferTarget
        });
        transferCall(mediaStream, transferTarget);
      }
    }

    // Update conversation history
    if (prompt !== "START_CONVERSATION") {
      conversationManager.addMessage(streamSid, 'user', prompt);
    }
    conversationManager.addMessage(streamSid, 'assistant', responseText);

    // Ensure final flush of audio
    mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));

  } catch (error) {
    console.error('Error in Claude stream:', error);
    
    const errorResponse = "I apologize, but I'm having a bit of trouble. Could you please repeat that?";
    
    mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 
      'type': 'Speak', 
      'text': errorResponse 
    }));
    mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
  }
}










// Helper function for farewell detection
function isFarewell(message) {
  const FAREWELL_PHRASES = [
    'goodbye', 'bye', 'thank you bye', 'thanks bye', 'have a nice day', 
    'that\'s all', 'that is all', 'no thanks', 'nothing else',
    'that\'s it', 'that will be all'
  ];
  
  return FAREWELL_PHRASES.some(phrase => 
    message.toLowerCase().includes(phrase)
  );
}

// Helper function to clean response text for TTS
function cleanResponseForTTS(text) {
  // Remove markdown tone indicators within asterisks
  text = text.replace(/\*.*?\*/g, '');
  
  // Remove square brackets and their contents
  text = text.replace(/\[.*?\]/g, '');
  
  // Remove any remaining special characters or formatting
  text = text.replace(/[_~`]/g, '');
  
  // Remove any HTML-like tags
  text = text.replace(/<[^>]*>/g, '');
  
  // Clean up multiple spaces
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}


// Add these new route handlers
dispatcher.onGet("/monitor", function (req, res) {
  serverLog('Monitor page requested');
  let filePath = path.join(__dirname, "monitor.html");
  
  fs.readFile(filePath, function(error, content) {
      if (error) {
          serverLog(`Error loading monitor page: ${error.message}`, 'error');
          res.writeHead(500);
          res.end('Error loading monitor page');
          return;
      }
      
      serverLog('Monitor page served successfully');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content, 'utf-8');
  });
});
// Add this function to get active calls from Twilio
async function getActiveTwilioCalls() {
  try {
      const calls = await twilioClient.calls.list({
          status: 'in-progress'
      });
      
      return calls.map(call => ({
          phoneNumber: call.from,
          status: call.status,
          startTime: call.startTime,
          duration: call.duration + 's',
          callSid: call.sid,
          direction: call.direction
      }));
  } catch (error) {
      console.error('Error fetching Twilio calls:', error);
      throw error;
  }
}

// Modify the existing /api/calls endpoint to use Twilio directly
dispatcher.onGet("/api/calls", async function (req, res) {
  try {
      serverLog('Call data requested from Twilio');
      const calls = await getActiveTwilioCalls();
      
      serverLog(`Returning ${calls.length} active calls from Twilio`);
      res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
      });
      res.end(JSON.stringify(calls));
  } catch (error) {
      serverLog(`Error serving Twilio call data: ${error.message}`, 'error');
      res.writeHead(500);
      res.end(JSON.stringify({ 
          error: 'Failed to fetch Twilio calls',
          message: error.message 
      }));
  }
});
dispatcher.onPost("/api/intervene", async function (req, res) {
  try {
    console.log("hello")
    // Get the raw request body data
    const data = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', data => body += data);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    console.log("data of the api",data)

    // Parse the JSON data
    const { callSid, interventionNumber } = JSON.parse(data);

    // Validate required fields
    if (!callSid || !interventionNumber) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'CallSid and interventionNumber are required' }));
      return;
    }

    // Format and validate phone number
    const formattedNumber = interventionNumber.replace(/[^\d+]/g, '');
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = '+' + formattedNumber;
    }

    if (formattedNumber.replace('+', '').length < 7) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid phone number format' }));
      return;
    }

    // Verify call exists and is active
    const call = await twilioClient.calls(callSid).fetch();
    if (call.status !== 'in-progress') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Call is not active' }));
      return;
    }

    // Perform the intervention
    await twilioClient.calls(callSid).update({
      twiml: `<Response><Dial>${formattedNumber}</Dial></Response>`
    });

    // Send success response
    res.writeHead(200);
    res.end(JSON.stringify({ 
      success: true,
      message: 'Call intervention initiated'
    }));

  } catch (error) {
    serverLog(`Error in intervention: ${error.message}`, 'error');
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});

// Add a debug endpoint to check active calls
dispatcher.onGet("/api/debug/calls", function (req, res) {
  try {
      const debug = {
          activeCallsCount: activeCalls.size,
          calls: Array.from(activeCalls.entries()).map(([sid, call]) => ({
              sid,
              ...call
          }))
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(debug, null, 2));
  } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
  }
});


function containsAnyChars(str) {
  let strArray = Array.from(str);
  return strArray.some(char => chars_to_check.includes(char));
}

function transferCall(mediaStream, target) {
  console.log('\n=== Transfer Call Initiated ===');
  
  if (!streamSid) {
    console.error('Error: No streamSid available for transfer');
    return;
  }
  
  if (!mediaStream.callSid) {
    console.error('Error: No callSid available for transfer');
    return;
  }
  
  let transferNumber;
  switch (target) {
    case SERVICES.COMMERCIAL_AGENT:
      transferNumber = TRANSFER_NUMBERS.COMMERCIAL_AGENT;
      break;
    case SERVICES.QUERIES_ASSISTANT:
      transferNumber = TRANSFER_NUMBERS.QUERIES_ASSISTANT;
      break;
    case 'EMERGENCY':
      transferNumber = TRANSFER_NUMBERS.EMERGENCY;
      break;
    default:
      console.error('Error: Invalid transfer target:', target);
      return;
  }
  
  console.log('Step 1: Transfer Details Prepared', {
    streamSid: streamSid,
    callSid: mediaStream.callSid,
    target: target,
    transferNumber: transferNumber
  });

  try {
    // First, announce the transfer
    if (mediaStream.deepgramTTSWebsocket) {
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({
        'type': 'Speak',
        'text': `I'll transfer your call now. Please hold.`
      }));
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
    }

    // Wait for the announcement to complete before initiating transfer
    setTimeout(() => {
      // Send transfer event through WebSocket
      const transferMessage = {
        event: 'transfer',
        streamSid: streamSid,
        target: target,
        targetNumber: transferNumber,
        callSid: mediaStream.callSid
      };
      
      mediaStream.connection.sendUTF(JSON.stringify(transferMessage));
      console.log('Step 2: Transfer message sent through WebSocket');
      
      // Validate Twilio credentials
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        throw new Error('Missing Twilio credentials');
      }
      
      console.log('Step 3: Twilio credentials validated');
      
      // Add error handling and validation for the call
      twilioClient.calls(mediaStream.callSid)
        .fetch()
        .then(call => {
          console.log('Step 4: Call fetched from Twilio:', call.sid, 'Status:', call.status);
          
          if (call.status !== 'in-progress') {
            throw new Error(`Call is not in progress. Current status: ${call.status}`);
          }
          
          return twilioClient.calls(mediaStream.callSid)
            .update({
              twiml: `<Response><Dial>${transferNumber}</Dial></Response>`
            });
        })
        .then(call => {
          console.log('Step 5: Twilio transfer successful:', call.sid);
          console.log('Twilio Response:', call);
          
          // Clean up the conversation after successful transfer
          setTimeout(() => {
            if (mediaStream.deepgramTTSWebsocket) {
              mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
              mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
            }
          }, 1000);
        })
        .catch(err => {
          console.error('Step 6: Twilio transfer failed:', err);
          
          // Handle specific error cases
          if (err.code === 20404) {
            console.log('Call not found - may have ended or been disconnected');
            // Cleanup connection
            if (mediaStream.connection) {
              mediaStream.connection.close();
            }
          } else {
            // For other errors, try to inform the caller
            const errorMessage = {
              event: 'transfer_error',
              streamSid: streamSid,
              error: 'Unable to transfer call. Please try again.'
            };
            mediaStream.connection.sendUTF(JSON.stringify(errorMessage));
            
            if (mediaStream.deepgramTTSWebsocket) {
              mediaStream.deepgramTTSWebsocket.send(JSON.stringify({
                'type': 'Speak',
                'text': 'I apologize, but I\'m having trouble transferring your call. Please try calling back in a few minutes.'
              }));
              mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
            }
          }
        });
    }, 2000); // Wait 2 seconds for the transfer announcement to complete

  } catch (error) {
    console.error('Step 7: Error during transfer:', error);
    
    // Attempt to notify the caller of the error
    if (mediaStream.deepgramTTSWebsocket) {
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({
        'type': 'Speak',
        'text': 'I apologize, but there was an error transferring your call. Please try calling back in a few minutes.'
      }));
      mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Flush' }));
    }
  }
}


const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('deepgram TTS: Connected');
    
    // Send initial greeting when WebSocket is ready
    if (!initialGreetingSent && mediaStream.callSid) {
      const greetingMessage = getRandomPhrase([
        "Thank you for calling Legal Firm Reception, how can I help you today?",
        "Welcome to Legal Firm Reception. . . , how can I help you today?",
        "Thank you for calling Legal Firm Reception. . . , how can I help you today?"
      ]);
      speaking = true;
      ws.send(JSON.stringify({ 
        'type': 'Speak', 
        'text': greetingMessage 
      }));
      ws.send(JSON.stringify({ 'type': 'Flush' }));
      
      // Update conversation state
      conversationManager.updateClientInfo(streamSid, { state: 'AWAITING_INITIAL_RESPONSE' });
      conversationManager.addMessage(streamSid, 'assistant', greetingMessage);
      
      initialGreetingSent = true;
    }
  });

  ws.on('message', function incoming(data) {
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        console.log('deepgram TTS: ', data.toString());
        return;
      } catch (e) {
        // Ignore
      }
      if (firstByte) {
        const ttsEndTime = Date.now();
        const ttsDuration = ttsEndTime - ttsStartTime;
        ttsTimes.push(ttsDuration);
        
        console.log('\n=== Deepgram TTS Timing ===');
        console.log('Time to First Byte:', msToSeconds(ttsDuration), 'seconds');
        console.log('Average TTS Response Time:', msToSeconds(calculateAverage(ttsTimes)), 'seconds');
        firstByte = false;
        
        if (send_first_sentence_input_time) {
          const sentenceTTSDuration = ttsEndTime - send_first_sentence_input_time;
          console.log('Time from sentence end to TTS:', msToSeconds(sentenceTTSDuration), 'seconds');
        }
      }
      const payload = data.toString('base64');
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload,
        },
      };
      mediaStream.connection.sendUTF(JSON.stringify(message));
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected');
    printTimingStats();
  });

  ws.on('error', function error(err) {
    console.error('deepgram TTS: error:', err);
  });

  return ws;
}


const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    model: "nova-2-conversationalai",
    language: "en",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    no_delay: true,
    interim_results: true,
    endpointing: 20,
    utterance_end_ms: 1000
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          const sttEndTime = Date.now();
          const sttDuration = sttEndTime - sttStartTime;
          transcriptionTimes.push(sttDuration);
          
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log('\n=== Deepgram STT Timing ===');
            console.log('Speech Final Duration:', msToSeconds(sttDuration), 'seconds');
            console.log('Average STT Response Time:', msToSeconds(calculateAverage(transcriptionTimes)), 'seconds');
            console.log(`Transcript: ${utterance}`);
            
            llmStart = Date.now();
            promptLLM(mediaStream, utterance);
          } else {
            console.log(`deepgram STT: [Is Final] ${transcript}`);
            console.log('Interim Final Duration:', msToSeconds(sttDuration), 'seconds');
          }
        } else {
          if (!sttStartTime) {
            sttStartTime = Date.now();
          }
          console.log(`deepgram STT: [Interim Result] ${transcript}`);
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            const messageJSON = JSON.stringify({
              "event": "clear",
              "streamSid": streamSid,
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ 'type': 'Clear' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        const utterance = is_finals.join(" ");
        is_finals = [];
        const sttEndTime = Date.now();
        const utteranceDuration = sttEndTime - utteranceStartTime;
        
        console.log('\n=== Deepgram Utterance Timing ===');
        console.log('Total Utterance Duration:', msToSeconds(utteranceDuration), 'seconds');
        console.log(`Transcript: ${utterance}`);
        
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
      // Reset timing for next utterance
      utteranceStartTime = Date.now();
      sttStartTime = Date.now();
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: disconnected");
      printTimingStats();
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.error("deepgram STT: error:", error);
    });
  });

  return deepgram;
};


// Add utility functions for timing calculations
function calculateAverage(times) {
  if (times.length === 0) return 0;
  const sum = times.reduce((a, b) => a + b, 0);
  return sum / times.length;
}

function calculatePercentile(times, percentile) {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index];
}

function printTimingStats() {
  console.log('\n=== Final Timing Statistics ===');
  console.log('Speech-to-Text (STT):');
  console.log('  Average Response Time:', msToSeconds(calculateAverage(transcriptionTimes)), 'seconds');
  console.log('  95th Percentile:', msToSeconds(calculatePercentile(transcriptionTimes, 95)), 'seconds');
  console.log('  Max Response Time:', msToSeconds(Math.max(...transcriptionTimes)), 'seconds');
  console.log('  Total Transcriptions:', transcriptionTimes.length);
  
  console.log('\nText-to-Speech (TTS):');
  console.log('  Average Response Time:', msToSeconds(calculateAverage(ttsTimes)), 'seconds');
  console.log('  95th Percentile:', msToSeconds(calculatePercentile(ttsTimes, 95)), 'seconds');
  console.log('  Max Response Time:', msToSeconds(Math.max(...ttsTimes)), 'seconds');
  console.log('  Total TTS Requests:', ttsTimes.length);
}


wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
 
 
 
