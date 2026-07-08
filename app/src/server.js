const { createApp } = require('./app');

// Cloud Run injects PORT; 8080 is its conventional default and works locally.
const port = Number(process.env.PORT) || 8080;

createApp().listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`securevault listening on ${port}`);
});
