#!/bin/bash

echo "🚀 Starting Daily Mix BD Deployment..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build the project
echo "🛠 Building the project..."
npm run build

# Start the server
echo "✅ Deployment complete! Starting server..."
npm start
