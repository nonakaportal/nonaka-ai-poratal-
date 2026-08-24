// frontend/js/theme.js

/**
 * Theme Manager - Handles Day/Night toggle with persistence
 */
class ThemeManager {
 constructor() {
 this.themeToggle = document.getElementById('theme-toggle');
 this.currentTheme = localStorage.getItem('theme') || 'light';
 this.init();
 }

 init() {
 // Apply saved theme on load
 this.setTheme(this.currentTheme);

 // Add click listener
 if (this.themeToggle) {
 this.themeToggle.addEventListener('click', () => this.toggleTheme());
 }
 }

 setTheme(theme) {
 document.documentElement.setAttribute('data-theme', theme);
 this.currentTheme = theme;
 localStorage.setItem('theme', theme);

 // Update button icon
 if (this.themeToggle) {
 this.themeToggle.textContent = theme === 'light' ? '' : '';
 }
 }

 toggleTheme() {
 const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
 this.setTheme(newTheme);
 }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
 new ThemeManager();
});