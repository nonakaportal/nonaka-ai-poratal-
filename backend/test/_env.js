// Loaded first by every test file. The services read these at require time
// and refuse to start without them; none of the tests touch the network.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.QB_CLIENT_ID = 'test-client-id';
process.env.QB_CLIENT_SECRET = 'test-client-secret';
process.env.QB_REDIRECT_URI = 'http://localhost/callback';
