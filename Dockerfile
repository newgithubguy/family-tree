FROM nginx:1.27-alpine

# Remove default nginx web root content.
RUN rm -rf /usr/share/nginx/html/*

# Copy static app files.
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY app.js /usr/share/nginx/html/app.js

# Use custom nginx config for SPA-friendly static serving.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
