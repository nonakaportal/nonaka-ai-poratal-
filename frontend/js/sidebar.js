// frontend/js/sidebar.js

/**
 * Sidebar Manager - Handles Accordion behavior and active states
 */
class SidebarManager {
  constructor() {
    this.groups = document.querySelectorAll('.accordion-group');
    this.navLinks = document.querySelectorAll('.nav-link');
    this.init();
  }

  init() {
    // 1. Accordion Toggle Logic
    this.groups.forEach(group => {
      const header = group.querySelector('.accordion-header');
      header.addEventListener('click', () => {
        // Toggle the clicked group
        group.classList.toggle('open');
      });
    });

    // 2. Active Link Highlighting
    this.navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault(); // Prevent default jump
        
        // Remove active class from all links
        this.navLinks.forEach(l => l.classList.remove('active'));
        
        // Add active class to clicked link
        link.classList.add('active');
        
        // Update the main page title (for now)
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) {
          pageTitle.textContent = link.textContent;
        }
      });
    });
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new SidebarManager();
});